use std::collections::HashSet;
use std::path::{MAIN_SEPARATOR, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::redactor::SecretMatcher;
use std::io::{self, Error};

use crate::search::walk_files;
use crate::tool_contracts::ToolOutcomeKind;

const CONTIGUOUS_BONUS: f64 = 8.0;
const BOUNDARY_BONUS: f64 = 6.0;
const PREFIX_BONUS: f64 = 12.0;
const EXACT_BONUS: f64 = 20.0;
const GAP_PENALTY: f64 = 1.0;
const DISTANCE_PENALTY: f64 = 0.2;
const LENGTH_PENALTY: f64 = 0.05;
const WORKSPACE_RESULT_LIMIT: usize = 20;

mod score;
mod workspace;

use score::{PreparedField, compact, score_terms, terms};

pub use score::{FuzzyCandidate, FuzzyField, batch_scores};
pub use workspace::{
    PathRanker, WorkspaceIndex, WorkspaceIndexTask, WorkspaceSearchResult, WorkspaceSearchTask,
    create_workspace_index,
};
