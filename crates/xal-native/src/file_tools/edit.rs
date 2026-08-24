use super::*;

#[napi(object)]
pub struct NativeEditRequest {
    pub path: Option<String>,
    pub expected_path: Option<String>,
    pub display_path: String,
    pub old_string: Option<Utf16String>,
    pub new_string: Option<Utf16String>,
    pub replace_all: Option<bool>,
}
fn match_positions(haystack: &[u16], needle: &[u16]) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut positions = Vec::new();
    let mut cursor = 0;
    while cursor + needle.len() <= haystack.len() {
        let Some(relative) = haystack[cursor..]
            .windows(needle.len())
            .position(|window| window == needle)
        else {
            break;
        };
        let position = cursor + relative;
        positions.push(position);
        cursor = position + needle.len();
    }
    positions
}

fn replace_matches(
    previous: &[u16],
    old: &[u16],
    new: &[u16],
    positions: &[usize],
    replace_all: bool,
) -> Vec<u16> {
    let count = if replace_all { positions.len() } else { 1 };
    let mut next = Vec::with_capacity(previous.len());
    let mut cursor = 0;
    for position in positions.iter().take(count).copied() {
        next.extend_from_slice(&previous[cursor..position]);
        next.extend_from_slice(new);
        cursor = position + old.len();
    }
    next.extend_from_slice(&previous[cursor..]);
    next
}

pub struct EditTask {
    path: PathBuf,
    expected_path: Option<String>,
    display_path: String,
    old: Vec<u16>,
    new: Vec<u16>,
    replace_all: bool,
}

impl Task for EditTask {
    type Output = NativeToolOutput;
    type JsValue = NativeToolOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        validate_expected_path(&self.path, self.expected_path.clone())?;
        let metadata = fs::metadata(&self.path)
            .map_err(|_| failed(format!("File not found: {}", self.display_path)))?;
        if metadata.is_dir() {
            return Err(failed(format!(
                "Path is a directory, not a file: {}",
                self.display_path
            )));
        }
        let previous_text =
            String::from_utf8(fs::read(&self.path).map_err(io_error)?).map_err(|error| {
                invalid(format!(
                    "Cannot edit binary file {}: {error}",
                    self.display_path
                ))
            })?;
        let previous = previous_text.encode_utf16().collect::<Vec<_>>();
        let positions = match_positions(&previous, &self.old);
        let matches = checked_count(positions.len(), "edit match")?;
        if positions.is_empty() {
            return Err(failed(format!(
                "old_string not found in {}. It must match the file text exactly, including whitespace and indentation.",
                self.display_path
            )));
        }
        if positions.len() > 1 && !self.replace_all {
            return Err(failed(format!(
                "old_string matches {matches} locations in {}. Add surrounding lines to make it unique, or set replace_all to true.",
                self.display_path
            )));
        }
        let next = replace_matches(
            &previous,
            &self.old,
            &self.new,
            &positions,
            self.replace_all,
        );
        let diff = unified_diff(&previous, &next);
        fs::write(&self.path, utf16_lossy(&next).as_bytes()).map_err(io_error)?;
        Ok(NativeToolOutput {
            output: with_diff(
                format!(
                    "Updated {} (+{} -{})",
                    self.display_path, diff.added, diff.removed
                ),
                &diff.hunks,
            )
            .into(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "nativeEditFile", catch_unwind)]
pub fn native_edit_file(request: NativeEditRequest) -> napi::Result<AsyncTask<EditTask>> {
    let old = request
        .old_string
        .ok_or_else(|| invalid("old_string is required and must be non-empty"))?;
    if old.is_empty() {
        return Err(invalid("old_string is required and must be non-empty"));
    }
    let new = request
        .new_string
        .ok_or_else(|| invalid("new_string is required"))?;
    if old.to_vec() == new.to_vec() {
        return Err(invalid(
            "old_string and new_string are identical; nothing to change",
        ));
    }
    Ok(AsyncTask::new(EditTask {
        path: required_path(request.path)?,
        expected_path: request.expected_path,
        display_path: request.display_path,
        old: old.to_vec(),
        new: new.to_vec(),
        replace_all: request.replace_all.unwrap_or(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::{match_positions, replace_matches, units};

    #[test]
    fn counts_non_overlapping_utf16_matches() {
        let previous = units("same same same");
        let old = units("same");
        let positions = match_positions(&previous, &old);
        assert_eq!(positions, vec![0, 5, 10]);
        assert_eq!(
            replace_matches(&previous, &old, &units("next"), &positions, true),
            units("next next next")
        );
        assert!(match_positions(&previous, &[]).is_empty());
    }
}
