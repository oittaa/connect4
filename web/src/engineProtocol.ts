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
  | { id: number; type: "availableScores"; scores: number[] }
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
      origin: string;
      score: number | null;
      fromMoveBook: boolean;
      extra: string;
    }
  | { id: number; type: "ttSaved" }
  | { id: number; type: "error"; message: string };
