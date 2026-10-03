use std::io;

pub(crate) fn signal_group(
    pid: u32,
    signal: i32,
    mut reap: impl FnMut() -> io::Result<()>,
) -> io::Result<()> {
    let pid = i32::try_from(pid).map_err(io::Error::other)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        if unsafe { libc::kill(-pid, signal) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        if error.raw_os_error() != Some(libc::EPERM) || std::time::Instant::now() >= deadline {
            return Err(error);
        }
        reap()?;
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn exited_group_leader_is_reaped_before_retrying_a_refused_signal() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .process_group(0)
            .spawn()
            .unwrap();
        let mut info = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            },
            0
        );
        super::signal_group(child.id(), libc::SIGKILL, || child.try_wait().map(|_| ())).unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(7));
    }
}
