extern crate self as wasi_ext;
use std::cell::RefCell;
use std::collections::VecDeque;
thread_local! { static INPUT: RefCell<VecDeque<Option<Vec<u8>>>> = RefCell::new(VecDeque::new()); }
pub enum RecvOutcome { Read(usize), Eof, WouldBlock }
pub fn socket(_:u32,_:u32,_:u32)->Result<u32,i32>{Ok(1)}
pub fn connect(_:u32,_:&[u8])->Result<(),i32>{Ok(())}
pub fn tls_connect(_:u32,_:&[u8])->Result<(),i32>{Ok(())}
pub fn set_recv_timeout_ms(_:u32,_:u32)->Result<(),i32>{Ok(())}
pub fn net_close_socket(_:u32)->Result<(),i32>{Ok(())}
pub fn send(_:u32,b:&[u8],_:u32)->Result<usize,i32>{Ok(b.len())}
pub fn recv_cooperative(_:u32,b:&mut[u8],_:u32)->Result<RecvOutcome,i32>{INPUT.with(|q|match q.borrow_mut().pop_front(){Some(Some(v))=>{assert!(v.len()<=b.len());b[..v.len()].copy_from_slice(&v);Ok(RecvOutcome::Read(v.len()))},Some(None)=>Ok(RecvOutcome::WouldBlock),None=>Ok(RecvOutcome::Eof)})}
#[path="chunk-test-library.rs"] mod http;
#[test]
fn split_chunk_survives_would_block(){
 INPUT.with(|q|*q.borrow_mut()=VecDeque::from([Some(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nB\r\ndata: ".to_vec()),None,Some(b"ping\n\r\n0\r\n\r\n".to_vec())]));
 let (_,mut reader)=http::HttpClient::new().send_raw_stream(&http::Request::new(http::Method::Get,"http://fixture.test/stream").unwrap()).unwrap();
 assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::WouldBlock));
 match reader.read_chunk().unwrap(){http::ChunkPoll::Ready(v)=>assert_eq!(v,b"data: ping\n"),_=>panic!("Expected intact body")}
 assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::Eof));
}

#[test]
fn body_and_terminator_can_pause_repeatedly(){
 INPUT.with(|q|*q.borrow_mut()=VecDeque::from([Some(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nB\r\ndata".to_vec()),None,Some(b": ping\n".to_vec()),None,Some(b"\r".to_vec()),None,Some(b"\n0\r\n\r\n".to_vec())]));
 let (_,mut reader)=http::HttpClient::new().send_raw_stream(&http::Request::new(http::Method::Get,"http://fixture.test/stream").unwrap()).unwrap();
 for _ in 0..3 { assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::WouldBlock)); }
 match reader.read_chunk().unwrap(){http::ChunkPoll::Ready(v)=>assert_eq!(v,b"data: ping\n"),_=>panic!("Expected intact body")}
 assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::Eof));
}
#[test]
fn complete_chunks_and_next_size_remain_intact(){
 INPUT.with(|q|*q.borrow_mut()=VecDeque::from([Some(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n3\r\nt".to_vec()),None,Some(b"wo\r\n0\r\n\r\n".to_vec())]));
 let (_,mut reader)=http::HttpClient::new().send_raw_stream(&http::Request::new(http::Method::Get,"http://fixture.test/stream").unwrap()).unwrap();
 match reader.read_chunk().unwrap(){http::ChunkPoll::Ready(v)=>assert_eq!(v,b"one"),_=>panic!("Expected first chunk")}
 assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::WouldBlock));
 match reader.read_chunk().unwrap(){http::ChunkPoll::Ready(v)=>assert_eq!(v,b"two"),_=>panic!("Expected second chunk")}
 assert!(matches!(reader.read_chunk().unwrap(),http::ChunkPoll::Eof));
}
