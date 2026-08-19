//! Sidecar placement e2e against a real sidecar. Verifies that default VMs use distinct processes
//! while an explicit shared pool reuses one process. No V8/WASM required.

mod common;

use agentos_client::fs::FileContent;

#[tokio::test]
async fn shared_sidecar_pooling_reuses_one_process() {
    if !common::require_sidecar("shared_sidecar_pooling_reuses_one_process") {
        return;
    }

    // Shared placement is an explicit same-trust-domain optimization.
    let a = common::new_vm_with_sidecar_pool("sidecar-placement").await;
    let b = common::new_vm_with_sidecar_pool("sidecar-placement").await;

    let desc_a = a.sidecar().describe();
    let desc_b = b.sidecar().describe();
    assert_eq!(
        desc_a.sidecar_id, desc_b.sidecar_id,
        "both VMs should share the same pooled sidecar"
    );
    assert_eq!(
        desc_a.active_vm_count, 2,
        "the shared sidecar should report 2 active VMs"
    );

    // Sharing a process must not break VM isolation.
    a.write_file("/tmp/who", FileContent::Text("A".to_string()))
        .await
        .expect("write A");
    b.write_file("/tmp/who", FileContent::Text("B".to_string()))
        .await
        .expect("write B");
    assert_eq!(a.read_file("/tmp/who").await.expect("read A"), b"A");
    assert_eq!(b.read_file("/tmp/who").await.expect("read B"), b"B");

    // Releasing one VM leaves the sibling working and drops the shared count to 1.
    a.shutdown().await.expect("shutdown A");
    assert_eq!(
        a.sidecar().describe().active_vm_count,
        1,
        "active_vm_count should drop to 1 after one VM releases"
    );
    assert_eq!(b.read_file("/tmp/who").await.expect("B still live"), b"B");

    b.shutdown().await.expect("shutdown B");
}

#[tokio::test]
async fn default_sidecar_placement_uses_distinct_processes() {
    if !common::require_sidecar("default_sidecar_placement_uses_distinct_processes") {
        return;
    }

    let a = common::new_vm().await;
    let b = common::new_vm().await;

    let desc_a = a.sidecar().describe();
    let desc_b = b.sidecar().describe();
    assert_ne!(
        desc_a.sidecar_id, desc_b.sidecar_id,
        "default VMs must not share a sidecar process"
    );
    assert_eq!(desc_a.active_vm_count, 1);
    assert_eq!(desc_b.active_vm_count, 1);

    a.shutdown().await.expect("shutdown A");
    b.shutdown().await.expect("shutdown B");
}
