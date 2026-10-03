use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use super::{check, invalid, read_text};

#[derive(Clone, Debug)]
pub struct Template {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub body: String,
    pub path: PathBuf,
}

fn scalar(raw: &str, path: &Path, key: &str) -> io::Result<String> {
    let value = raw.trim();
    let error = |reason| invalid(format!("{}: {key} {reason}", path.display()));
    if value.is_empty() {
        return Err(error("must not be empty"));
    }
    if value.starts_with('"') || value.ends_with('"') {
        let text: String =
            serde_json::from_str(value).map_err(|_| error("has an invalid quoted value"))?;
        if text.contains(['\n', '\r']) {
            return Err(error("must be one line"));
        }
        return Ok(text);
    }
    if value.starts_with('\'') || value.ends_with('\'') {
        if !value.starts_with('\'') || !value.ends_with('\'') || value.len() < 2 {
            return Err(error("has an invalid quoted value"));
        }
        return Ok(value[1..value.len() - 1].replace("''", "'"));
    }
    Ok(value.into())
}

pub fn parse(path: &Path, name: &str, content: &str) -> io::Result<Template> {
    if !name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && !name.as_bytes().first().is_some_and(u8::is_ascii_digit)
        || !name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err(invalid(format!(
            "{}: command names must use lower-case letters, numbers, hyphens, or underscores",
            path.display()
        )));
    }
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut body = normalized.as_str();
    let mut values = BTreeMap::new();
    if let Some(rest) = body.strip_prefix("---\n") {
        let end = rest
            .match_indices("\n---")
            .find(|(index, _)| rest[*index + 4..].starts_with('\n') || rest.len() == *index + 4)
            .map(|(index, _)| index)
            .ok_or_else(|| invalid(format!("{}: frontmatter is not closed", path.display())))?;
        for line in rest[..end].lines().filter(|line| !line.trim().is_empty()) {
            let (key, value) = line.split_once(':').ok_or_else(|| {
                invalid(format!(
                    "{}: invalid frontmatter line: {line}",
                    path.display()
                ))
            })?;
            let key = key.trim();
            if !["description", "argument-hint"].contains(&key) {
                return Err(invalid(format!(
                    "{}: unsupported frontmatter field: {key}",
                    path.display()
                )));
            }
            if values.insert(key, scalar(value, path, key)?).is_some() {
                return Err(invalid(format!(
                    "{}: duplicate frontmatter field: {key}",
                    path.display()
                )));
            }
        }
        body = rest[end + 4..].trim_start_matches('\n');
    }
    let body = body.trim();
    if body.is_empty() {
        return Err(invalid(format!(
            "{}: prompt body must not be empty",
            path.display()
        )));
    }
    Ok(Template {
        name: name.into(),
        description: values
            .remove("description")
            .unwrap_or_else(|| "run a custom prompt".into()),
        argument_hint: values.remove("argument-hint"),
        body: body.into(),
        path: path.into(),
    })
}

pub fn load(
    directories: &[PathBuf],
    cancelled: &AtomicBool,
) -> io::Result<BTreeMap<String, Template>> {
    let mut templates = BTreeMap::new();
    for directory in directories {
        check(cancelled)?;
        let mut entries = match fs::read_dir(directory) {
            Ok(entries) => entries.collect::<io::Result<Vec<_>>>()?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_type()?.is_file()
                || entry
                    .path()
                    .extension()
                    .is_none_or(|extension| extension != "md")
            {
                continue;
            }
            let path = entry.path();
            let name = path
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("command filename is not valid Unicode"))?;
            let template = parse(&path, name, &read_text(&path, None, cancelled)?)?;
            templates.insert(template.name.clone(), template);
        }
    }
    Ok(templates)
}

impl Template {
    pub fn expand(&self, args: &[String]) -> String {
        let mut result = String::new();
        let mut rest = self.body.as_str();
        while let Some(index) = rest.find('$') {
            result.push_str(&rest[..index]);
            rest = &rest[index + 1..];
            if let Some(tail) = rest.strip_prefix('$') {
                result.push('$');
                rest = tail;
            } else if let Some(tail) = rest.strip_prefix("ARGUMENTS") {
                result.push_str(&args.join(" "));
                rest = tail;
            } else if rest
                .as_bytes()
                .first()
                .is_some_and(|byte| (b'1'..=b'9').contains(byte))
            {
                let end = rest.bytes().take_while(u8::is_ascii_digit).count();
                if let Ok(number) = rest[..end].parse::<usize>()
                    && let Some(arg) = args.get(number - 1)
                {
                    result.push_str(arg);
                }
                rest = &rest[end..];
            } else {
                result.push('$');
            }
        }
        result.push_str(rest);
        result
    }
}
