use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde_yaml::Value;

use super::{check, invalid, read_text};
use crate::skill::{Request, resources, supporting_files, walk_files};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    User,
    Project,
}

pub struct Root {
    pub directory: PathBuf,
    pub source: Source,
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub directory: PathBuf,
    pub path: PathBuf,
    pub source: Source,
}

#[derive(Clone, Debug, Default)]
pub struct Catalog {
    pub skills: BTreeMap<String, Skill>,
    pub warnings: Vec<String>,
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn repair(frontmatter: &str) -> Option<String> {
    let mut changed = false;
    let mut block_indent = None;
    let mut repaired = Vec::new();
    for line in frontmatter.split('\n') {
        let indent = line.len() - line.trim_start_matches(' ').len();
        if let Some(block) = block_indent {
            if line.trim().is_empty() || indent > block {
                repaired.push(line.into());
                continue;
            }
            block_indent = None;
        }
        let Some((key, value)) = line.split_once(':') else {
            repaired.push(line.into());
            continue;
        };
        if key.trim().is_empty()
            || value
                .chars()
                .next()
                .is_some_and(|character| !character.is_whitespace())
        {
            repaired.push(line.into());
            continue;
        }
        let trimmed = value.trim_start();
        let leading = &value[..value.len() - trimmed.len()];
        let comment_start = trimmed
            .char_indices()
            .find(|(index, character)| {
                *character == '#'
                    && (*index == 0
                        || trimmed[..*index]
                            .chars()
                            .next_back()
                            .is_some_and(char::is_whitespace))
            })
            .map(|(index, _)| trimmed[..index].trim_end().len());
        let (scalar, comment) = comment_start.map_or((trimmed.trim_end(), ""), |index| {
            (trimmed[..index].trim_end(), &trimmed[index..])
        });
        let Some(first) = scalar.chars().next() else {
            repaired.push(line.into());
            continue;
        };
        if first == '|' || first == '>' {
            block_indent = Some(indent);
            repaired.push(line.into());
            continue;
        }
        if first == '\'' || first == '"' {
            repaired.push(line.into());
            continue;
        }
        let invalid_flow =
            ['[', '{', '@', '`'].contains(&first) && serde_yaml::from_str::<Value>(scalar).is_err();
        let colon_space = scalar.match_indices(':').any(|(index, _)| {
            scalar[index + 1..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        });
        if !invalid_flow && !colon_space {
            repaired.push(line.into());
            continue;
        }
        repaired.push(format!(
            "{key}:{leading}'{}'{comment}",
            scalar.replace('\'', "''")
        ));
        changed = true;
    }
    changed.then(|| repaired.join("\n"))
}

pub fn parse(path: &Path, content: &str, source: Source) -> io::Result<Skill> {
    let normalized = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let error = |reason: &str| invalid(format!("{}: {reason}", path.display()));
    let (first, rest) = normalized
        .split_once('\n')
        .ok_or_else(|| error("SKILL.md must begin with closed YAML frontmatter"))?;
    if first.trim_matches([' ', '\t']) != "---" {
        return Err(error("SKILL.md must begin with closed YAML frontmatter"));
    }
    let mut offset = 0;
    let mut closed = None;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches('\n').trim_matches([' ', '\t']) == "---" {
            closed = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let (end, body) =
        closed.ok_or_else(|| error("SKILL.md must begin with closed YAML frontmatter"))?;
    let frontmatter = &rest[..end];
    let fields: Value = match serde_yaml::from_str(frontmatter) {
        Ok(value) => value,
        Err(original) => {
            let repaired = repair(frontmatter)
                .ok_or_else(|| error(&format!("invalid YAML frontmatter: {original}")))?;
            serde_yaml::from_str(&repaired)
                .map_err(|_| error(&format!("invalid YAML frontmatter: {original}")))?
        }
    };
    let fields = fields
        .as_mapping()
        .ok_or_else(|| error("frontmatter must be an object"))?;
    let directory = path
        .parent()
        .ok_or_else(|| error("skill directory missing"))?;
    let fallback = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error("skill directory name is not valid Unicode"))?;
    let raw_name = match fields.get(Value::String("name".into())) {
        None => fallback,
        Some(value) => value
            .as_str()
            .ok_or_else(|| error("name must be a string"))?,
    };
    let name = single_line(raw_name);
    let name = if name.is_empty() {
        fallback.into()
    } else {
        name
    };
    if name.chars().count() > 64 {
        return Err(error("name must not exceed 64 characters"));
    }
    let description = fields
        .get(Value::String("description".into()))
        .and_then(Value::as_str)
        .ok_or_else(|| error("description is required"))?;
    let description = single_line(description);
    if description.is_empty() {
        return Err(error("description is required"));
    }
    Ok(Skill {
        name,
        description,
        body: rest[body..].trim().into(),
        directory: directory.into(),
        path: path.into(),
        source,
    })
}

pub fn roots(home: &Path, user_home: &Path, project: &Path, trusted: bool) -> Vec<Root> {
    let mut roots = vec![
        Root {
            directory: user_home.join(".agents/skills"),
            source: Source::User,
        },
        Root {
            directory: home.join("skills"),
            source: Source::User,
        },
    ];
    if trusted {
        roots.extend([
            Root {
                directory: project.join(".agents/skills"),
                source: Source::Project,
            },
            Root {
                directory: project.join(".xal/skills"),
                source: Source::Project,
            },
        ]);
    }
    roots
}

pub fn load(roots: &[Root], cancelled: &AtomicBool) -> io::Result<Catalog> {
    let mut catalog = Catalog::default();
    for root in roots {
        let mut names = HashSet::new();
        for path in walk_files(&root.directory, None, cancelled)?
            .into_iter()
            .filter(|path| path.file_name().is_some_and(|name| name == "SKILL.md"))
        {
            check(cancelled)?;
            let outcome = read_text(&path, Some(64 * 1024), cancelled)
                .and_then(|content| parse(&path, &content, root.source));
            match outcome {
                Ok(skill) => {
                    if !names.insert(skill.name.clone()) {
                        return Err(invalid(format!(
                            "{}: duplicate skill name: {}",
                            root.directory.display(),
                            skill.name
                        )));
                    }
                    catalog.skills.insert(skill.name.clone(), skill);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
                Err(error) => {
                    let message = error.to_string();
                    let prefix = format!("{}: ", path.display());
                    catalog.warnings.push(if message.starts_with(&prefix) {
                        message
                    } else {
                        format!("{prefix}{message}")
                    });
                }
            }
        }
    }
    Ok(catalog)
}

pub fn compact_description(description: &str) -> String {
    let normalized = single_line(description);
    if normalized.encode_utf16().count() <= 160 {
        return normalized;
    }
    let mut units = 0;
    let mut end = 0;
    let mut boundary = None;
    for (index, character) in normalized.char_indices() {
        if units + character.len_utf16() > 159 {
            break;
        }
        if character == ' ' && units > 80 {
            boundary = Some(index);
        }
        units += character.len_utf16();
        end = index + character.len_utf8();
    }
    format!("{}…", normalized[..boundary.unwrap_or(end)].trim_end())
}

impl Skill {
    pub fn request(&self, resource: Option<String>) -> Request {
        Request {
            name: self.name.clone(),
            directory: self.directory.to_string_lossy().into_owned(),
            skill_path: self.path.to_string_lossy().into_owned(),
            body: self.body.clone(),
            resource,
        }
    }
}

impl Catalog {
    pub fn prompt(&self) -> String {
        if self.skills.is_empty() {
            return String::new();
        }
        let mut lines = vec!["Available skills follow. Load one when its description matches, or when the user explicitly invokes $name. Full instructions load on demand with the skill tool.".into()];
        lines.extend(self.skills.values().map(|skill| {
            format!(
                "- {}: {}",
                skill.name,
                compact_description(&skill.description)
            )
        }));
        lines.join("\n")
    }

    pub fn expand(&self, input: &str, cancelled: &AtomicBool) -> io::Result<Option<String>> {
        check(cancelled)?;
        let end = input.find(char::is_whitespace).unwrap_or(input.len());
        let Some(name) = input[..end].strip_prefix('$') else {
            return Ok(None);
        };
        let Some(skill) = self.skills.get(name) else {
            return Ok(None);
        };
        let rest = &input[end..];
        let arguments = rest
            .chars()
            .next()
            .map_or("", |character| &rest[character.len_utf8()..]);
        let files = supporting_files(&skill.directory, &skill.path, cancelled)?;
        Ok(Some([
            "The selected skill package is already loaded for this request. Follow it without calling the skill tool to load it again. Treat the user input as verbatim text and do not perform variable, path, command, template, or shell expansion.".to_owned(),
            format!("Skill: {}", skill.name), format!("Directory: {}", skill.directory.display()), resources(&files), skill.body.clone(),
            format!("User input ({} UTF-8 bytes):\n{arguments}\nEnd user input.", arguments.len()),
        ].join("\n\n")))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Reference {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

pub fn references(text: &str, catalog: &Catalog) -> Vec<Reference> {
    let mut found = Vec::new();
    for (start, _) in text.match_indices('$') {
        let mut end = start + 1;
        let bytes = text.as_bytes();
        while end < bytes.len() {
            if bytes[end].is_ascii_lowercase() || bytes[end].is_ascii_digit() {
                end += 1;
                continue;
            }
            if bytes[end] == b'-'
                && bytes
                    .get(end + 1)
                    .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                && end > start + 1
            {
                end += 1;
                continue;
            }
            break;
        }
        let name = &text[start + 1..end];
        if catalog.skills.contains_key(name) {
            let offset = text[..start].encode_utf16().count();
            found.push(Reference {
                name: name.into(),
                start: offset,
                end: offset + text[start..end].encode_utf16().count(),
            });
        }
    }
    found
}

#[derive(Debug, PartialEq, Eq)]
pub struct Query {
    pub start: usize,
    pub end: usize,
    pub query: String,
}

pub fn query(text: &str, cursor: usize) -> Option<Query> {
    let mut units = 0;
    let mut end = 0;
    for character in text.chars() {
        if units == cursor {
            break;
        }
        units += character.len_utf16();
        if units > cursor {
            return None;
        }
        end += character.len_utf8();
    }
    if units != cursor {
        return None;
    }
    let prefix = &text[..end];
    let start = prefix.rfind('$')?;
    let query = &prefix[start + 1..];
    if query.chars().any(char::is_whitespace) {
        return None;
    }
    Some(Query {
        start: text[..start].encode_utf16().count(),
        end: cursor,
        query: query.into(),
    })
}
