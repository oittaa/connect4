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
  | { id: number; type: "fetchScoreBook"; url: string }
  | { id: number; type: "fetchMoveBook"; url: string }
  | { id: number; type: "loadScoreBook"; bytes: ArrayBuffer }
  | { id: number; type: "loadMoveBook"; bytes: ArrayBuffer }
  | { id: number; type: "clearDownloadedBooks" }
  | { id: number; type: "setTimeout"; ms: number }
  | { id: number; type: "solve"; moves: number[] }
  | { id: number; type: "analyze"; moves: number[] }
  | { id: number; type: "bestMove"; moves: number[] };

export type WorkerRes =
  | {
      id: number;
      type: "ready";
      bookLen: number;
      bookDepth: number;
      moveBookPopulated: number;
      moveBookDepth: number;
    }
  | {
      id: number;
      type: "solved";
      score: number;
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      key: string;
    }
  | {
      id: number;
      type: "analyzed";
      scores: number[];
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      key: string;
    }
  | {
      id: number;
      type: "moved";
      col: number;
      moveScores: CompleteColumnScores | null;
      nodes: number;
      micros: number;
      timedOut: boolean;
      fromCache: boolean;
      fromMoveBook: boolean;
      key: string;
    }
  | { id: number; type: "error"; message: string };
