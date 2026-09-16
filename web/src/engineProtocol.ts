/** Indexed by column. `INVALID` (-1000) marks a full column. */
export type CompleteColumnScores = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type WorkerReq =
  | { id: number; type: "init"; timeoutMs: number }
  | { id: number; type: "loadScoreBook"; bytes: ArrayBuffer }
  | { id: number; type: "loadMoveBook"; bytes: ArrayBuffer }
  | { id: number; type: "clearDownloadedBooks" }
  | { id: number; type: "analyze"; moves: number[] }
  | { id: number; type: "availableScores"; moves: number[] }
  | { id: number; type: "bestMove"; moves: number[] }
  | { id: number; type: "saveTT" };

export type WorkerRes =
  | {
      id: number;
      type: "availableScores";
      scores: number[];
      /** 0-based move-book suggestion, or 255 if none. Uncertified preview. */
      moveBookCol: number;
    }
  | {
      id: number;
      type: "ready";
      scoreBookLen: number;
      scoreBookMoves: number;
      moveBookPopulated: number;
      moveBookMoves: number;
    }
  | {
      id: number;
      type: "analyzed";
      scores: number[];
      nodes: number;
      micros: number;
      timedOut: boolean;
      /** Set when analysis proved an optimal column (never a bare book hint). */
      provenCol?: number;
    }
  | {
      id: number;
      type: "moved";
      col: number;
      moveScores: CompleteColumnScores | null;
      /** Exact scores already known, with INVALID for unknown or full columns. */
      hintScores: number[];
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromMoveBook: boolean;
    }
  | { id: number; type: "ttSaved" }
  | { id: number; type: "error"; message: string };
