use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

#[derive(Debug)]
pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub interrupted: bool,
}

#[cfg(unix)]
fn kill_tree(child: &mut Child) -> io::Result<()> {
    crate::process::signal_group(child.id(), libc::SIGKILL, || child.try_wait().map(|_| ()))
}

#[cfg(windows)]
fn kill_tree(_child: &mut Child, tree: &crate::process::ProcessTree) -> io::Result<()> {
    tree.terminate()
}

pub fn run_git(
    cwd: &str,
    args: &[String],
    index_file: Option<&str>,
    input: Option<&[u8]>,
    cancelled: Option<&dyn Fn() -> bool>,
) -> io::Result<GitOutput> {
    if cancelled.is_some_and(|cancelled| cancelled()) {
        return Ok(GitOutput {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: 130,
            interrupted: true,
        });
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .arg("--literal-pathspecs")
        .args(["-c", "core.autocrlf=false"])
        .args(["-c", "core.longpaths=true"])
        .args(["-c", "core.symlinks=true"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(unix)]
    let mut child = command
        .spawn()
        .map_err(|error| io::Error::other(format!("could not run git: {error}")))?;
    #[cfg(windows)]
    let (mut child, tree) = crate::process::ProcessTree::spawn(&mut command)
        .map_err(|error| io::Error::other(format!("could not run git: {error}")))?;
    let mut stdin = child.stdin.take().expect("git stdin was piped");
    let input = input.map(<[u8]>::to_vec).unwrap_or_default();
    let input_thread = thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child.stdout.take().expect("git stdout was piped");
    let stdout_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child.stderr.take().expect("git stderr was piped");
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut status = None;
    let mut interrupted = false;
    let mut failures = Vec::new();
    loop {
        if cancelled.is_some_and(|cancelled| cancelled()) {
            interrupted = true;
            if let Err(error) = kill_tree(
                &mut child,
                #[cfg(windows)]
                &tree,
            ) {
                failures.push(format!("could not stop git process tree: {error}"));
            }
            if status.is_none() {
                match child.wait() {
                    Ok(exited) => status = Some(exited),
                    Err(error) => failures.push(format!("could not wait for git: {error}")),
                }
            }
            break;
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(exited) => status = exited,
                Err(error) => {
                    failures.push(format!("could not wait for git: {error}"));
                    if let Err(error) = kill_tree(
                        &mut child,
                        #[cfg(windows)]
                        &tree,
                    ) {
                        failures.push(format!("could not stop git process tree: {error}"));
                    }
                    if let Err(error) = child.wait() {
                        failures.push(format!("could not reap git: {error}"));
                    }
                    break;
                }
            }
        }
        if status.is_some()
            && input_thread.is_finished()
            && stdout_thread.is_finished()
            && stderr_thread.is_finished()
        {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let input = input_thread.join();
    let stdout = stdout_thread.join();
    let stderr = stderr_thread.join();
    match input {
        Ok(Ok(())) => {}
        Ok(Err(error)) if error.kind() == io::ErrorKind::BrokenPipe => {}
        Ok(Err(error)) => failures.push(format!("could not send input to git: {error}")),
        Err(_) => failures.push("git input thread panicked".into()),
    }
    let mut collect = |result: thread::Result<io::Result<Vec<u8>>>, stream: &str| match result {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            failures.push(format!("could not read git {stream}: {error}"));
            Vec::new()
        }
        Err(_) => {
            failures.push(format!("git {stream} thread panicked"));
            Vec::new()
        }
    };
    let stdout = collect(stdout, "output");
    let stderr = collect(stderr, "error output");
    if !failures.is_empty() {
        return Err(io::Error::other(failures.join("; ")));
    }
    Ok(GitOutput {
        stdout,
        stderr,
        exit_code: status
            .and_then(|status| status.code())
            .unwrap_or(if interrupted { 130 } else { 1 }),
        interrupted,
    })
}
