export interface RankedResult {
  filePath: string;
  score: number;
}

export interface LabeledQuery {
  query: string;
  relevant: string[];
}

export interface EvalMetrics {
  mrr: number;
  ndcgAt10: number;
  precisionAt5: number;
  recallAt10: number;
}

export function evaluateQueries(
  labels: LabeledQuery[],
  resultsByQuery: Map<string, RankedResult[]>,
): EvalMetrics {
  if (labels.length === 0) {
    return {
      mrr: 0,
      ndcgAt10: 0,
      precisionAt5: 0,
      recallAt10: 0,
    };
  }

  let mrr = 0;
  let ndcg = 0;
  let p5 = 0;
  let r10 = 0;

  for (const label of labels) {
    const ranked = uniqueByFilePath(resultsByQuery.get(label.query) ?? []);
    mrr += reciprocalRank(ranked, label.relevant);
    ndcg += ndcgAtK(ranked, label.relevant, 10);
    p5 += precisionAtK(ranked, label.relevant, 5);
    r10 += recallAtK(ranked, label.relevant, 10);
  }

  const n = labels.length;
  return {
    mrr: mrr / n,
    ndcgAt10: ndcg / n,
    precisionAt5: p5 / n,
    recallAt10: r10 / n,
  };
}

function reciprocalRank(results: RankedResult[], relevant: string[]): number {
  const set = new Set(relevant);
  for (let i = 0; i < results.length; i++) {
    if (set.has(results[i].filePath)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function precisionAtK(results: RankedResult[], relevant: string[], k: number): number {
  if (k <= 0) return 0;
  const set = new Set(relevant);
  const top = results.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter((result) => set.has(result.filePath)).length;
  return hits / k;
}

function recallAtK(results: RankedResult[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const set = new Set(relevant);
  const top = results.slice(0, k);
  const hits = top.filter((result) => set.has(result.filePath)).length;
  return hits / relevant.length;
}

function ndcgAtK(results: RankedResult[], relevant: string[], k: number): number {
  const set = new Set(relevant);
  const dcg = results
    .slice(0, k)
    .reduce((acc, result, idx) => {
      if (!set.has(result.filePath)) return acc;
      return acc + 1 / log2(idx + 2);
    }, 0);

  const idealHits = Math.min(k, relevant.length);
  const idcg = Array.from({ length: idealHits })
    .reduce((acc, _, idx) => acc + 1 / log2(idx + 2), 0);

  if (idcg === 0) return 0;
  return dcg / idcg;
}

function log2(value: number): number {
  return Math.log(value) / Math.log(2);
}

function uniqueByFilePath(results: RankedResult[]): RankedResult[] {
  const seen = new Set<string>();
  const out: RankedResult[] = [];

  for (const result of results) {
    if (seen.has(result.filePath)) continue;
    seen.add(result.filePath);
    out.push(result);
  }

  return out;
}
