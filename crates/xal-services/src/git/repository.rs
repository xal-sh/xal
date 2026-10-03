use super::*;

pub struct Repository {
    workspace: String,
    root: OnceLock<String>,
}

impl Repository {
    pub fn new(workspace: String) -> std::io::Result<Self> {
        if workspace.is_empty() {
            return Err(Error::new(
                std::io::ErrorKind::InvalidInput,
                "Git repository path is required",
            ));
        }
        Ok(Self {
            workspace,
            root: OnceLock::new(),
        })
    }

    pub fn root(&self) -> std::io::Result<&str> {
        if let Some(root) = self.root.get() {
            return Ok(root);
        }
        let root = repository_root(&self.workspace)?
            .to_string_lossy()
            .into_owned();
        Ok(self.root.get_or_init(|| root))
    }

    pub fn capture(&self, request: &CaptureRequest) -> std::io::Result<String> {
        capture_tree(&self.workspace, &request.forced, request.full)
    }

    pub fn changed_paths(&self, request: &TreePairRequest) -> std::io::Result<Vec<String>> {
        let output = checked_git(
            self.root()?,
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                &request.before,
                &request.after,
                "--",
            ],
            None,
            None,
        )?;
        nul_paths(&output.stdout)
    }

    pub fn index_state(&self, paths: &[String]) -> std::io::Result<Vec<u8>> {
        index_state(self.root()?, paths)
    }

    pub fn head_state(&self) -> std::io::Result<String> {
        head_state(self.root()?)
    }

    pub fn gitlinks(&self, request: &GitlinksRequest) -> std::io::Result<Vec<Gitlink>> {
        gitlinks(self.root()?, request)
    }

    pub fn apply_snapshot(&self, request: &ApplySnapshotRequest) -> std::io::Result<()> {
        apply_snapshot(&self.workspace, request)
    }
}
