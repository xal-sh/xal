use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use rmcp::RoleClient;
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::transport::async_rw::AsyncRwTransport;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;

const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const STDERR_BYTES: usize = 64 * 1024;
const GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(3);
const FORCED_SHUTDOWN: Duration = Duration::from_secs(1);

struct LimitedLineReader<R> {
    inner: R,
    line_bytes: usize,
}

impl<R> LimitedLineReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            line_bytes: 0,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for LimitedLineReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let available = MAX_LINE_BYTES
            .saturating_sub(self.line_bytes)
            .saturating_add(1)
            .min(buffer.remaining());
        let read = {
            let mut limited = buffer.take(available);
            match Pin::new(&mut self.inner).poll_read(context, &mut limited) {
                Poll::Ready(Ok(())) => limited.filled().len(),
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            }
        };
        unsafe { buffer.assume_init(read) };
        buffer.advance(read);
        for byte in &buffer.filled()[before..] {
            if *byte == b'\n' {
                self.line_bytes = 0;
                continue;
            }
            self.line_bytes = self.line_bytes.saturating_add(1);
            if self.line_bytes > MAX_LINE_BYTES {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("MCP stdio message exceeds {MAX_LINE_BYTES} bytes"),
                )));
            }
        }
        Poll::Ready(Ok(()))
    }
}

struct LimitedLineWriter<W> {
    inner: W,
    line_bytes: usize,
}

impl<W> LimitedLineWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            line_bytes: 0,
        }
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for LimitedLineWriter<W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        let mut line_bytes = self.line_bytes;
        for byte in bytes {
            if *byte == b'\n' {
                line_bytes = 0;
                continue;
            }
            line_bytes = line_bytes.saturating_add(1);
            if line_bytes > MAX_LINE_BYTES {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("MCP stdio message exceeds {MAX_LINE_BYTES} bytes"),
                )));
            }
        }
        match Pin::new(&mut self.inner).poll_write(context, bytes) {
            Poll::Ready(Ok(written)) => {
                for byte in &bytes[..written] {
                    if *byte == b'\n' {
                        self.line_bytes = 0;
                    } else {
                        self.line_bytes += 1;
                    }
                }
                Poll::Ready(Ok(written))
            }
            result => result,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

pub(super) type StderrTail = Arc<Mutex<Vec<u8>>>;

pub(super) struct StdioTransport {
    child: Option<Child>,
    inner:
        AsyncRwTransport<RoleClient, LimitedLineReader<ChildStdout>, LimitedLineWriter<ChildStdin>>,
    stderr_task: Option<JoinHandle<()>>,
}

impl StdioTransport {
    pub(super) fn spawn(mut command: Command) -> io::Result<(Self, StderrTail)> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("MCP server stdin was unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("MCP server stdout was unavailable"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("MCP server stderr was unavailable"))?;
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let task_tail = stderr_tail.clone();
        let stderr_task = tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            loop {
                let count = match stderr.read(&mut buffer).await {
                    Ok(0) => return,
                    Ok(count) => count,
                    Err(_) => return,
                };
                let mut captured = super::lock(&task_tail);
                captured.extend_from_slice(&buffer[..count]);
                if captured.len() > STDERR_BYTES {
                    let remove = captured.len() - STDERR_BYTES;
                    captured.drain(..remove);
                }
            }
        });
        Ok((
            Self {
                child: Some(child),
                inner: AsyncRwTransport::new(
                    LimitedLineReader::new(stdout),
                    LimitedLineWriter::new(stdin),
                ),
                stderr_task: Some(stderr_task),
            },
            stderr_tail,
        ))
    }

    async fn stop_child(&mut self) -> io::Result<()> {
        self.inner.close().await?;
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let pid = child.id();
        match tokio::time::timeout(GRACEFUL_SHUTDOWN, child.wait()).await {
            Ok(Ok(_)) => {
                self.stop_stderr().await;
                return Ok(());
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => {}
        }
        terminate_process_tree(pid, false).await;
        match tokio::time::timeout(FORCED_SHUTDOWN, child.wait()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                terminate_process_tree(pid, true).await;
                child.start_kill()?;
                child.wait().await?;
            }
        }
        self.stop_stderr().await;
        Ok(())
    }

    async fn stop_stderr(&mut self) {
        if let Some(task) = self.stderr_task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        if let Some(task) = self.stderr_task.take() {
            task.abort();
        }
        let Some(mut child) = self.child.take() else {
            return;
        };
        let pid = child.id();
        terminate_process_tree_now(pid);
        let _ = child.start_kill();
    }
}

impl Transport<RoleClient> for StdioTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.inner.send(item)
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.inner.receive()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.stop_child()
    }
}

pub(super) fn stderr_text(stderr: &StderrTail) -> Option<String> {
    let text = String::from_utf8_lossy(&super::lock(stderr))
        .trim()
        .to_owned();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(unix)]
async fn terminate_process_tree(pid: Option<u32>, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(windows)]
async fn terminate_process_tree(pid: Option<u32>, force: bool) {
    let Some(pid) = pid else {
        return;
    };
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}

#[cfg(unix)]
fn terminate_process_tree_now(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree_now(pid: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
