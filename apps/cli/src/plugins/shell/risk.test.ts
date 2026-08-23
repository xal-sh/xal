import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { commandEscapesWorkspace, commandSubjects } from "./risk"

const cwd = "/workspace/project"

describe("commandEscapesWorkspace", () => {
  test("allows workspace-scoped file operations, including deletes", () => {
    for (const command of [
      "rm -rf node_modules",
      "rm src/old.ts dist/old.js",
      "rm -rf ./build",
      "mv src/a.ts src/b.ts",
      "cp -r src backup",
      "mkdir -p src/nested/dir",
      "touch .env.local",
      "chmod +x scripts/run.sh",
      "cd src",
      "tee output.log",
      "echo done > result.txt",
      "git status",
      "bun test",
      "find src -name '*.orig' -delete",
      "timeout 5 rm -rf build",
      "ls | xargs wc -l",
    ]) {
      expect(commandEscapesWorkspace(command, cwd)).toBe(false)
    }
  })

  test("allows writes to temporary directories and devices", () => {
    for (const command of ["mv report.txt /tmp/report.txt", "echo debug > /dev/null", "touch /tmp/scratch"]) {
      expect(commandEscapesWorkspace(command, cwd)).toBe(false)
    }
  })

  test("flags operations that reach outside the workspace", () => {
    for (const command of [
      "rm /etc/hosts",
      "rm -rf ../sibling",
      `rm ${homedir()}/notes.txt`,
      "rm ~/notes.txt",
      "touch /etc/cron.d/job",
      "mkdir /opt/tool",
      "chmod 777 /usr/local/bin/tool",
      "cp secrets.txt /var/data/",
      "cd /etc",
      "cd ..",
      "echo pwned > /etc/hosts",
      "tee /etc/hosts",
      "sort < input.txt > /etc/out",
      "bash -c -- 'rm /etc/hosts'",
      "bash -c -- '-x; rm /etc/hosts' argv0",
      "bash -c -O extglob -- 'rm /etc/hosts' argv0",
      "bash -xcO extglob 'rm /etc/hosts'",
      "bash -c 'rm /etc/hosts'",
      "bash -c -x -- 'rm /etc/hosts'",
      "bash -c",
    ]) {
      expect(commandEscapesWorkspace(command, cwd)).toBe(true)
    }
  })

  test("flags destructive commands aimed at the workspace root or its history", () => {
    for (const command of ["rm -rf .", "rm -rf ./", "rm -rf .git", "mv .git /tmp/git", "find . -delete"]) {
      expect(commandEscapesWorkspace(command, cwd)).toBe(true)
    }
  })

  test("flags paths it cannot resolve statically", () => {
    for (const command of ["rm $FILE", 'rm "$HOME/file"', "cd $DIR", "rm ~otheruser/file"]) {
      expect(commandEscapesWorkspace(command, cwd)).toBe(true)
    }
  })

  test("sees through quoting and wrappers", () => {
    expect(commandEscapesWorkspace("rm 'my file.txt'", cwd)).toBe(false)
    expect(commandEscapesWorkspace("rm '/etc/my file'", cwd)).toBe(true)
    expect(commandEscapesWorkspace('rm "quoted name.txt"', cwd)).toBe(false)
    expect(commandEscapesWorkspace("env nohup rm /etc/hosts", cwd)).toBe(true)
    expect(commandEscapesWorkspace("xargs rm", cwd)).toBe(true)
    expect(commandEscapesWorkspace("xargs -n 1 rm -f", cwd)).toBe(true)
    expect(commandEscapesWorkspace("xargs mkdir", cwd)).toBe(false)
    expect(commandSubjects("bash -xcO extglob 'rm /etc/hosts'")).toContain("rm /etc/hosts")
  })
})
