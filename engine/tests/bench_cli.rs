use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "c4-bench-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn write(&self, name: &str, body: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, body).unwrap();
        path
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_c4solver"))
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        for entry in fs::read_dir(&self.0).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
        fs::remove_dir(&self.0).unwrap();
    }
}

fn stdout_lines(output: &Output) -> Vec<String> {
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn score_line(line: &str) -> (String, i32, u64) {
    let mut fields = line.split_whitespace();
    let label = fields.next().unwrap().to_string();
    let score: i32 = fields.next().unwrap().parse().unwrap();
    let nodes: u64 = fields.next().unwrap().parse().unwrap();
    (label, score, nodes)
}

#[test]
fn limit_counts_only_real_lines() {
    let workspace = Workspace::new();
    let path = workspace.write(
        "commented.txt",
        "\
# comment
# another

4 -1
44 1
",
    );
    let file = path.to_str().unwrap();

    let one = workspace.run(&["bench", "--limit", "1", file]);
    assert!(
        one.status.success(),
        "{}",
        String::from_utf8_lossy(&one.stderr)
    );
    let lines = stdout_lines(&one);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(score_line(&lines[0]), ("4".to_string(), -1, 0));
    let err = String::from_utf8_lossy(&one.stderr);
    assert!(err.contains("1/1 correct"), "{err}");

    let two = workspace.run(&["bench", "--limit", "2", file]);
    assert!(
        two.status.success(),
        "{}",
        String::from_utf8_lossy(&two.stderr)
    );
    let lines = stdout_lines(&two);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!(score_line(&lines[0]), ("4".to_string(), -1, 0));
    assert_eq!(score_line(&lines[1]), ("44".to_string(), 1, 0));

    let blocked = workspace.write(
        "blocked.txt",
        "\
# skip

12121212 18
4 -1
",
    );
    let output = workspace.run(&["bench", "--limit", "1", blocked.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stdout_lines(&output).is_empty());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("cannot play 12121212"), "{err}");
    assert!(err.contains("0/1 correct"), "{err}");
}

#[test]
fn last_move_win_is_scored_like_go() {
    let workspace = Workspace::new();
    let path = workspace.write(
        "wins.txt",
        "\
1212121 18
21314161 17
1223533464474 -4
",
    );
    let output = workspace.run(&["bench", path.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = stdout_lines(&output);
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(score_line(&lines[0]), ("1212121".to_string(), 18, 0));
    assert_eq!(score_line(&lines[1]), ("21314161".to_string(), 17, 0));
    let (label, score, nodes) = score_line(&lines[2]);
    assert_eq!(label, "1223533464474");
    assert_eq!(score, -4);
    assert_eq!(nodes, 34539);

    let mid = workspace.write("mid.txt", "12121212 18\n");
    let rejected = workspace.run(&["bench", mid.to_str().unwrap()]);
    assert_eq!(rejected.status.code(), Some(1));
    assert!(stdout_lines(&rejected).is_empty());
    let err = String::from_utf8_lossy(&rejected.stderr);
    assert!(err.contains("cannot play 12121212"), "{err}");
}

#[test]
fn extra_fields_and_malformed_lines_are_rejected() {
    let workspace = Workspace::new();
    let extra = workspace.write("extra.txt", "4444 1 extra\n");
    let output = workspace.run(&["bench", extra.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stdout_lines(&output).is_empty());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("expected sequence score"), "{err}");
    assert!(err.contains("4444 1 extra"), "{err}");

    let bad = workspace.write("bad.txt", "44 zz\n");
    let output = workspace.run(&["bench", bad.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stdout_lines(&output).is_empty());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("expected a score"), "{err}");

    let mixed = workspace.write(
        "mixed.txt",
        "\
4 -1
4444 1 extra
",
    );
    let output = workspace.run(&["bench", mixed.to_str().unwrap()]);
    assert_eq!(output.status.code(), Some(1));
    let lines = stdout_lines(&output);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(score_line(&lines[0]), ("4".to_string(), -1, 0));
    assert!(String::from_utf8_lossy(&output.stderr).contains("expected sequence score"));
}

#[test]
fn pons_lines_comments_and_lone_score_still_score() {
    let workspace = Workspace::new();
    let path = workspace.write(
        "pons.txt",
        "\
# header

44 1

1
4 -1
",
    );
    let output = workspace.run(&["bench", path.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = stdout_lines(&output);
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(score_line(&lines[0]), ("44".to_string(), 1, 0));
    assert_eq!(score_line(&lines[1]), ("-".to_string(), 1, 0));
    assert_eq!(score_line(&lines[2]), ("4".to_string(), -1, 0));
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(err.contains("3/3 correct"), "{err}");
}
