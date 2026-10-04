use super::*;

#[napi(object)]
pub struct NativeGitCommandRequest {
    pub args: Vec<String>,
    pub index_file: Option<String>,
    pub input: Option<Buffer>,
}

#[napi(object)]
pub struct NativeGitCommandOutput {
    pub stdout: Buffer,
    pub stderr: Buffer,
    pub exit_code: i32,
    pub interrupted: bool,
}

pub(crate) struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

pub(crate) fn run_git(
    cwd: &str,
    args: &[String],
    index_file: Option<&str>,
    input: Option<&[u8]>,
    cancelled: Option<&AtomicBool>,
) -> Result<GitOutput, String> {
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
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run git: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "git stdin was unavailable".to_owned())?;
    let input = input.map(<[u8]>::to_vec).unwrap_or_default();
    let input_thread = thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout was unavailable".to_owned())?;
    let stdout_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr was unavailable".to_owned())?;
    let stderr_thread = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let (status, interrupted) = loop {
        if cancelled.is_some_and(|cancelled| cancelled.load(std::sync::atomic::Ordering::Relaxed)) {
            let _ = child.kill();
            break (
                child
                    .wait()
                    .map_err(|error| format!("could not wait for git: {error}"))?,
                true,
            );
        }
        match child
            .try_wait()
            .map_err(|error| format!("could not wait for git: {error}"))?
        {
            Some(status) => break (status, false),
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    let input_result = input_thread
        .join()
        .map_err(|_| "git input thread panicked".to_owned())?;
    if let Err(error) = input_result
        && error.kind() != std::io::ErrorKind::BrokenPipe
    {
        return Err(format!("could not send input to git: {error}"));
    }
    let stdout = stdout_thread
        .join()
        .map_err(|_| "git output thread panicked".to_owned())?
        .map_err(|error| format!("could not read git output: {error}"))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| "git error thread panicked".to_owned())?
        .map_err(|error| format!("could not read git error output: {error}"))?;
    Ok(GitOutput {
        stdout,
        stderr,
        exit_code: status.code().unwrap_or(if interrupted { 130 } else { 1 }),
    })
}
pub struct GitCommandTask {
    pub(super) cwd: String,
    pub(super) request: NativeGitCommandRequest,
    pub(super) cancelled: Arc<AtomicBool>,
}

impl Task for GitCommandTask {
    type Output = NativeGitCommandOutput;
    type JsValue = NativeGitCommandOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let output = run_git(
            &self.cwd,
            &self.request.args,
            self.request.index_file.as_deref(),
            self.request.input.as_deref(),
            Some(&self.cancelled),
        )
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
        Ok(NativeGitCommandOutput {
            stdout: output.stdout.into(),
            stderr: output.stderr.into(),
            exit_code: output.exit_code,
            interrupted: self.cancelled.load(std::sync::atomic::Ordering::Relaxed),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}
