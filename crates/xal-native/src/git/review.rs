use super::*;

#[napi(object)]
pub struct NativeReviewDiffRequest {
    pub cwd: String,
    pub base: Option<String>,
    pub aborted: Option<bool>,
}

#[napi(object)]
pub struct NativeReviewDiffOutput {
    pub output: String,
}

fn git_text(cwd: &str, args: &[&str], cancelled: &AtomicBool) -> napi::Result<String> {
    let owned = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git(cwd, &owned, None, None, Some(cancelled))
        .map_err(|message| Error::new(Status::GenericFailure, message))?;
    if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(Error::new(
            Status::Cancelled,
            "Git command interrupted".to_owned(),
        ));
    }
    if output.exit_code != 0 {
        let detail = String::from_utf8_lossy(&output.stderr)
            .trim()
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        let suffix = if detail.is_empty() {
            format!(" with exit code {}", output.exit_code)
        } else {
            format!(": {detail}")
        };
        return Err(Error::new(
            Status::GenericFailure,
            format!(
                "git {} failed{suffix}",
                args.first().copied().unwrap_or("command")
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned())
}

pub struct ReviewDiffTask {
    request: NativeReviewDiffRequest,
    cancelled: Arc<AtomicBool>,
}

impl Task for ReviewDiffTask {
    type Output = NativeReviewDiffOutput;
    type JsValue = NativeReviewDiffOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.request.aborted.unwrap_or(false) {
            return Err(Error::new(
                Status::Cancelled,
                "Git command interrupted".to_owned(),
            ));
        }
        let root = git_text(
            &self.request.cwd,
            &["rev-parse", "--show-toplevel"],
            &self.cancelled,
        )?;
        let status = git_text(
            &root,
            &["status", "--short", "--untracked-files=all"],
            &self.cancelled,
        )?;
        let Some(base) = self.request.base.as_deref() else {
            if status.is_empty() {
                return Ok(NativeReviewDiffOutput {
                    output: "No working-tree changes.".to_owned(),
                });
            }
            let staged = git_text(
                &root,
                &["diff", "--cached", "--no-ext-diff", "--find-renames", "--"],
                &self.cancelled,
            )?;
            let unstaged = git_text(
                &root,
                &["diff", "--no-ext-diff", "--find-renames", "--"],
                &self.cancelled,
            )?;
            return Ok(NativeReviewDiffOutput {
                output: [
                    "Git status:".to_owned(),
                    status,
                    String::new(),
                    "Staged diff:".to_owned(),
                    if staged.is_empty() { "(none)".to_owned() } else { staged },
                    String::new(),
                    "Unstaged diff:".to_owned(),
                    if unstaged.is_empty() { "(none)".to_owned() } else { unstaged },
                    String::new(),
                    "Untracked file contents are not included in Git diffs. Inspect every untracked path listed in the status.".to_owned(),
                ]
                .join("\n"),
            });
        };
        let base_commit = git_text(
            &root,
            &[
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{base}^{{commit}}"),
            ],
            &self.cancelled,
        )?;
        let merge_base = git_text(
            &root,
            &["merge-base", &base_commit, "HEAD"],
            &self.cancelled,
        )?;
        let diff = git_text(
            &root,
            &["diff", "--no-ext-diff", "--find-renames", &merge_base, "--"],
            &self.cancelled,
        )?;
        let has_untracked = status.lines().any(|line| line.starts_with("?? "));
        if diff.is_empty() && !has_untracked {
            return Ok(NativeReviewDiffOutput {
                output: format!("No changes since the merge base with {base}."),
            });
        }
        Ok(NativeReviewDiffOutput {
            output: [
                format!("Base: {base_commit}"),
                format!("Merge base: {merge_base}"),
                String::new(),
                "Git status:".to_owned(),
                if status.is_empty() { "(clean)".to_owned() } else { status },
                String::new(),
                "Diff:".to_owned(),
                if diff.is_empty() { "(no tracked changes)".to_owned() } else { diff },
                String::new(),
                "Untracked file contents are not included in Git diffs. Inspect every untracked path listed in the status.".to_owned(),
            ]
            .join("\n"),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeReviewDiff", catch_unwind)]
pub fn native_review_diff(
    request: NativeReviewDiffRequest,
    signal: Option<AbortSignal>,
) -> napi::Result<AsyncTask<ReviewDiffTask>> {
    if request.cwd.is_empty() {
        return Err(Error::new(Status::InvalidArg, "cwd is required".to_owned()));
    }
    if request
        .base
        .as_ref()
        .is_some_and(|base| base.trim().is_empty())
    {
        return Err(Error::new(
            Status::InvalidArg,
            "base must be a non-empty Git revision".to_owned(),
        ));
    }
    let request = NativeReviewDiffRequest {
        cwd: request.cwd,
        base: request.base.map(|base| base.trim().to_owned()),
        aborted: request.aborted,
    };
    Ok(AsyncTask::new(ReviewDiffTask {
        request,
        cancelled: cancellation_flag(signal),
    }))
}
