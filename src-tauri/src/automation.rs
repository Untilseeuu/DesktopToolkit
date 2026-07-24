#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTask {
    #[serde(default)]
    pub commands: Vec<String>,
    pub working_directory: Option<String>,
    #[serde(default = "default_true")]
    pub show_terminal: bool,
    #[serde(default = "default_true")]
    pub close_terminal_on_finish: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecution {
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn execute_commands_with(
    commands: &[String],
    mut execute: impl FnMut(&str) -> CommandExecution,
) -> Vec<CommandExecution> {
    let mut results = Vec::new();
    for command in commands
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let result = execute(command);
        let success = result.success;
        results.push(result);
        if !success {
            break;
        }
    }
    results
}

pub(crate) fn terminal_script(commands: &[String]) -> String {
    commands
        .iter()
        .map(|command| command.trim())
        .filter(|command| !command.is_empty())
        .map(|command| format!("call {command}"))
        .collect::<Vec<_>>()
        .join(" && ")
}

pub(crate) fn terminal_mode(close_terminal_on_finish: bool) -> &'static str {
    if close_terminal_on_finish {
        "/C"
    } else {
        "/K"
    }
}

pub fn execute_task(task: &CommandTask) -> Result<Vec<CommandExecution>, String> {
    if task
        .commands
        .iter()
        .all(|command| command.trim().is_empty())
    {
        return Err("任务中没有可执行命令".into());
    }
    if let Some(directory) = task
        .working_directory
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !Path::new(directory).is_dir() {
            return Err(format!("工作目录不存在：{directory}"));
        }
    }
    if task.show_terminal {
        let script = terminal_script(&task.commands);
        let mut process = std::process::Command::new("cmd.exe");
        #[cfg(target_os = "windows")]
        process.creation_flags(0x0000_0010);
        process.args([
            "/D",
            "/S",
            terminal_mode(task.close_terminal_on_finish),
            &script,
        ]);
        if let Some(directory) = task
            .working_directory
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            process.current_dir(directory);
        }
        if task.close_terminal_on_finish {
            return Ok(vec![match process.status() {
                Ok(status) => CommandExecution {
                    command: script,
                    success: status.success(),
                    exit_code: status.code(),
                    stdout: String::new(),
                    stderr: String::new(),
                },
                Err(error) => CommandExecution {
                    command: script,
                    success: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
            }]);
        }
        return Ok(vec![match process.spawn() {
            Ok(_) => CommandExecution {
                command: script,
                success: true,
                exit_code: None,
                stdout: "任务已在同一个终端中启动；全部命令结束后终端会保持打开。".into(),
                stderr: String::new(),
            },
            Err(error) => CommandExecution {
                command: script,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }]);
    }
    Ok(execute_commands_with(&task.commands, |command| {
        let mut process = crate::background_command("cmd.exe");
        process.args(["/D", "/S", "/C", command]);
        if let Some(directory) = task
            .working_directory
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            process.current_dir(directory);
        }
        match process.output() {
            Ok(output) => CommandExecution {
                command: command.into(),
                success: output.status.success(),
                exit_code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
            Err(error) => CommandExecution {
                command: command.into(),
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    }))
}
