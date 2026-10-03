use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct Pipe<T> {
    stream: T,
    stop: Arc<AtomicBool>,
    configured: bool,
    remaining: Option<usize>,
}

impl<T: AsRawFd> Pipe<T> {
    pub(crate) fn new(stream: T, stop: Arc<AtomicBool>) -> Self {
        Self {
            stream,
            stop,
            configured: false,
            remaining: None,
        }
    }

    fn configure(&mut self) -> io::Result<()> {
        if self.configured {
            return Ok(());
        }
        let fd = self.stream.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
        {
            return Err(io::Error::last_os_error());
        }
        self.configured = true;
        Ok(())
    }

    fn poll(&self, events: libc::c_short) -> io::Result<()> {
        let mut descriptor = libc::pollfd {
            fd: self.stream.as_raw_fd(),
            events,
            revents: 0,
        };
        if unsafe { libc::poll(&mut descriptor, 1, 20) } == -1 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        if descriptor.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::from_raw_os_error(libc::EBADF));
        }
        Ok(())
    }
}

impl<T: Read + AsRawFd> Read for Pipe<T> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.configure()?;
        loop {
            if self.stop.load(Ordering::Acquire) && self.remaining.is_none() {
                let mut available: libc::c_int = 0;
                if unsafe { libc::ioctl(self.stream.as_raw_fd(), libc::FIONREAD, &mut available) }
                    == -1
                {
                    return Err(io::Error::last_os_error());
                }
                self.remaining = Some(usize::try_from(available).map_err(io::Error::other)?);
            }
            let length = self
                .remaining
                .map_or(buffer.len(), |left| left.min(buffer.len()));
            if length == 0 {
                return Ok(0);
            }
            match self.stream.read(&mut buffer[..length]) {
                Ok(count) => {
                    if let Some(remaining) = &mut self.remaining {
                        *remaining -= count;
                    }
                    return Ok(count);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.poll(libc::POLLIN)?
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl<T: Write + AsRawFd> Write for Pipe<T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.configure()?;
        loop {
            if self.stop.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "process pipe is closed",
                ));
            }
            match self.stream.write(buffer) {
                Ok(count) => return Ok(count),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    self.poll(libc::POLLOUT)?
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn stopping_reads_preserves_buffered_bytes_without_accepting_new_output() {
        let (reader, mut writer) = UnixStream::pair().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut reader = Pipe::new(reader, stop.clone());
        writer.write_all(b"buffered").unwrap();
        stop.store(true, Ordering::Release);
        let mut prefix = [0; 2];
        reader.read_exact(&mut prefix).unwrap();
        writer.write_all(b"later").unwrap();
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert_eq!(&prefix, b"bu");
        assert_eq!(rest, b"ffered");
    }
}
