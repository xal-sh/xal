export type SkillSource = "user" | "project"

interface SkillMetadata {
  name: string
  description: string
  body: string
}

export interface FileSkill extends SkillMetadata {
  source: SkillSource
  directory: string
  path: string
}

export interface BuiltinSkill extends SkillMetadata {
  source: "builtin"
  resources: ReadonlyMap<string, string>
}

export type Skill = FileSkill | BuiltinSkill
