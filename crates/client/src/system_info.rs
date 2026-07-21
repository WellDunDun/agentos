//! VM-scoped system limit introspection.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{AgentOs, ClientError};
use agentos_sidecar_client::wire;

/// Whether an effective limit came from the sidecar default or explicit VM configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemLimitSource {
    Default,
    Configured,
}

/// Broad grouping used by the limits inspector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemLimitCategory {
    Resource,
    Queue,
    Memory,
    Cpu,
    Unmeasured,
}

/// One effective limit and its VM-local observed usage, when the runtime has a gauge for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLimitInfo {
    pub name: String,
    pub config_path: String,
    pub description: String,
    pub category: SystemLimitCategory,
    pub unit: String,
    pub source: SystemLimitSource,
    pub used: Option<u64>,
    pub high_water: Option<u64>,
    pub capacity: Option<u64>,
    pub fill_percent: Option<u64>,
}

/// Complete sidecar-owned system information available for one VM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOsSystemInfo {
    pub limits: Vec<SystemLimitInfo>,
}

impl AgentOs {
    /// Return every effective VM limit, including live usage and high-water values where measured.
    pub async fn get_system_info(&self) -> Result<AgentOsSystemInfo> {
        let ownership = wire::OwnershipScope::VmOwnership(wire::VmOwnership {
            connection_id: self.connection_id().to_string(),
            session_id: self.wire_session_id().to_string(),
            vm_id: self.vm_id().to_string(),
        });
        let response = self
            .transport()
            .request_wire(ownership, wire::RequestPayload::GetResourceSnapshotRequest)
            .await
            .context("get_system_info: GetResourceSnapshot request failed")?;

        let snapshot = match response {
            wire::ResponsePayload::ResourceSnapshotResponse(snapshot) => snapshot,
            wire::ResponsePayload::RejectedResponse(rejected) => {
                return Err(ClientError::from_rejection(rejected).into());
            }
            other => {
                return Err(ClientError::Sidecar(format!(
                    "get_system_info: unexpected response {other:?}"
                ))
                .into());
            }
        };

        let limits = snapshot
            .limit_snapshots
            .into_iter()
            .map(|limit| {
                Ok(SystemLimitInfo {
                    name: limit.name,
                    config_path: limit.config_path,
                    description: limit.description,
                    category: parse_category(&limit.category)?,
                    unit: limit.unit,
                    source: parse_source(&limit.source)?,
                    used: limit.used,
                    high_water: limit.high_water,
                    capacity: limit.capacity,
                    fill_percent: limit.fill_percent,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(AgentOsSystemInfo { limits })
    }
}

fn parse_category(value: &str) -> Result<SystemLimitCategory> {
    match value {
        "resource" => Ok(SystemLimitCategory::Resource),
        "queue" => Ok(SystemLimitCategory::Queue),
        "memory" => Ok(SystemLimitCategory::Memory),
        "cpu" => Ok(SystemLimitCategory::Cpu),
        "unmeasured" => Ok(SystemLimitCategory::Unmeasured),
        other => Err(ClientError::Sidecar(format!(
            "get_system_info: unknown limit category {other:?}"
        ))
        .into()),
    }
}

fn parse_source(value: &str) -> Result<SystemLimitSource> {
    match value {
        "default" => Ok(SystemLimitSource::Default),
        "configured" => Ok(SystemLimitSource::Configured),
        other => Err(ClientError::Sidecar(format!(
            "get_system_info: unknown limit source {other:?}"
        ))
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sidecar_owned_limit_tags() {
        assert_eq!(
            parse_category("resource").expect("resource category"),
            SystemLimitCategory::Resource
        );
        assert_eq!(
            parse_category("unmeasured").expect("unmeasured category"),
            SystemLimitCategory::Unmeasured
        );
        assert_eq!(
            parse_source("default").expect("default source"),
            SystemLimitSource::Default
        );
        assert!(parse_category("unknown").is_err());
        assert!(parse_source("unknown").is_err());
    }
}
