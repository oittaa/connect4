use engine::{MoveBook, Position, ScoreBook};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "c4-book-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_c4solver"))
            .args(args)
            .current_dir(&self.0)
            .output()
            .unwrap()
    }

    fn succeeds(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
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

fn embedded_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../books/4ply.c4book")
}

#[test]
fn explicit_conversion_and_validation_commands() {
    let workspace = Workspace::new();
    let source = embedded_path();
    workspace.succeeds(&[
        "convert-score-to-move",
        "--score-book",
        source.to_str().unwrap(),
        "--out",
        "converted.c4move",
    ]);
    workspace.succeeds(&[
        "validate-move-book",
        "--score-book",
        source.to_str().unwrap(),
        "--move-book",
        "converted.c4move",
    ]);
    let move_book =
        MoveBook::load(&fs::read(workspace.0.join("converted.c4move")).unwrap()).unwrap();
    assert_eq!(move_book.max_ply(), 3);
    assert_eq!(move_book.get(&Position::new()), Some(3));
}

#[test]
fn direct_generation_resumes_without_publishing_partial_moves() {
    let workspace = Workspace::new();
    fs::write(workspace.0.join("empty.c4book"), ScoreBook::new().save()).unwrap();
    let args = [
        "gen-move-book",
        "--score-book",
        "empty.c4book",
        "--out",
        "generated.c4move",
        "--depth",
        "3",
        "--threads",
        "2",
        "--tt-bits",
        "16",
    ];
    let mut bounded = args.to_vec();
    bounded.extend(["--max-jobs", "5"]);
    workspace.succeeds(&bounded);
    assert!(workspace.0.join("generated.c4move.checkpoint").exists());
    assert!(!workspace.0.join("generated.c4move").exists());
    workspace.succeeds(&args);
    let source = embedded_path();
    workspace.succeeds(&[
        "validate-move-book",
        "--score-book",
        source.to_str().unwrap(),
        "--move-book",
        "generated.c4move",
    ]);
}

#[test]
fn score_generation_fills_holes_at_the_recorded_depth() {
    let workspace = Workspace::new();
    let mut partial = ScoreBook::new();
    let mut pos = Position::new();
    pos.play_seq("4455");
    partial.insert(pos.key3(), 18, 4);
    let path = workspace.0.join("partial.c4book");
    fs::write(&path, partial.save()).unwrap();
    workspace.succeeds(&[
        "gen-score-book",
        "--depth",
        "4",
        "--out",
        "partial.c4book",
        "--threads",
        "2",
        "--tt-bits",
        "16",
    ]);
    assert_eq!(fs::read(path).unwrap(), ScoreBook::opening_4ply().save());
}

#[test]
fn retired_or_invalid_options_fail_before_generation() {
    let workspace = Workspace::new();
    assert!(!workspace.run(&["gen-book"]).status.success());
    assert!(!workspace
        .run(&[
            "gen-move-book",
            "--scores",
            "input.c4book",
            "--out",
            "output.c4move"
        ])
        .status
        .success());
    assert!(!workspace
        .run(&[
            "gen-move-book",
            "--depth",
            "3",
            "--out",
            "output.c4move",
            "--threads",
            "oops"
        ])
        .status
        .success());
    assert!(!workspace
        .run(&["gen-score-book", "--depth"])
        .status
        .success());
    assert_eq!(fs::read_dir(&workspace.0).unwrap().count(), 0);
}
