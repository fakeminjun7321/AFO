import path from 'node:path';
import type { ComplexRule, FileSnapshot, PhotoInsight, RuleCondition, SmartReport } from '../../contracts/src/index.js';
import { pathKey } from './util.js';

export function conditionMatches(condition: RuleCondition, relativePath: string, file?: Partial<Pick<FileSnapshot, 'size' | 'modifiedNs'>>): boolean {
  if (condition.field === 'size') return file?.size !== undefined && (condition.operator === 'at-least' ? file.size >= condition.value : file.size <= condition.value);
  if (condition.field === 'modified') {
    if (file?.modifiedNs === undefined) return false;
    const date = new Date(Number(BigInt(file.modifiedNs) / 1_000_000n));
    const local = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return condition.operator === 'before' ? local < condition.value : local > condition.value;
  }
  const actual = pathKey(condition.field === 'path' ? relativePath : condition.field === 'extension' ? path.posix.extname(relativePath) : path.posix.basename(relativePath));
  const wanted = pathKey(condition.value);
  switch (condition.operator) {
    case 'contains': return actual.includes(wanted);
    case 'not-contains': return !actual.includes(wanted);
    case 'equals': return actual === wanted;
    case 'starts-with': return actual.startsWith(wanted);
    case 'ends-with': return actual.endsWith(wanted);
  }
}

export function complexMatches(rule: ComplexRule, relativePath: string, file?: Partial<Pick<FileSnapshot, 'size' | 'modifiedNs'>>): boolean {
  return rule.enabled && (rule.match === 'all' ? rule.conditions.every((c) => conditionMatches(c, relativePath, file))
    : rule.conditions.some((c) => conditionMatches(c, relativePath, file)));
}

export const hamming = (a: string, b: string): number => {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`); let count = 0;
  while (value) { value &= value - 1n; count++; }
  return count;
};
interface HashNode { photo: PhotoInsight; children: Map<number, HashNode> }
/** BK-tree candidate search; never feeds the exact-duplicate deletion list. Flat/featureless images are excluded. */
export function similarPhotos(photos: PhotoInsight[], threshold = 6): SmartReport['similar'] {
  const pairs: SmartReport['similar'] = [];
  let root: HashNode | undefined;
  for (const photo of photos.filter((p) => p.hash && p.averageHash && p.width && p.height && (p.variance ?? 0) >= 3).sort((a, b) => a.source.localeCompare(b.source))) {
    const visit = (node: HashNode): void => {
      const distance = hamming(photo.hash!, node.photo.hash!);
      if (distance <= threshold && pairs.length < 200) {
        const averageDistance = hamming(photo.averageHash!, node.photo.averageHash!);
        const a = photo.width! / photo.height!; const b = node.photo.width! / node.photo.height!;
        const colorDistance = photo.color && node.photo.color ? photo.color.reduce((n, x, i) => n + Math.abs(x - node.photo.color![i]!), 0) : 0;
        if (averageDistance <= threshold + 4 && Math.abs(Math.log(a / b)) < 0.15 && colorDistance < 100)
          pairs.push({ left: node.photo.source, right: photo.source, distance, averageDistance });
      }
      for (const [edge, child] of node.children) if (edge >= distance - threshold && edge <= distance + threshold) visit(child);
    };
    if (root) visit(root);
    const node: HashNode = { photo, children: new Map() };
    if (!root) root = node;
    else {
      let parent = root;
      for (;;) { const distance = hamming(photo.hash!, parent.photo.hash!); const child = parent.children.get(distance);
        if (child) parent = child; else { parent.children.set(distance, node); break; } }
    }
  }
  return pairs.sort((a, b) => a.distance - b.distance || a.left.localeCompare(b.left) || a.right.localeCompare(b.right));
}

export const contentTopics = [
  { target: '문서/물리', words: ['물리', '역학', '가속도', '전기장', '자기장', '운동량', 'physics', 'velocity', 'kinetic', 'momentum'] },
  { target: '문서/화학', words: ['화학', '몰농도', '산화', '환원', '화학반응', '적정', 'chemistry', 'molarity', 'titration'] },
  { target: '문서/수학', words: ['수학', '미분', '적분', '미분방정식', '행렬', '정리의 증명', 'calculus', 'derivative', 'integral', 'differential equation'] },
  { target: '문서/생명과학', words: ['생명과학', '세포', '유전자', '광합성', '단백질', 'biology', 'genetics', 'protein', 'photosynthesis'] },
  { target: '문서/천문', words: ['천문', '은하', '항성', '우주론', '적색편이', 'astronomy', 'galaxy', 'cosmology', 'redshift'] },
  { target: '문서/영수증', words: ['영수증', '결제금액', '승인번호', '공급가액', 'receipt', 'invoice', 'subtotal', 'amount due'] },
];
/** Keyword evidence is a heuristic score, never a measured accuracy or a trained classifier. */
export function contentSuggestion(text: string): { target: string; confidence: number; reason: string } | null {
  const normalized = text.normalize('NFC').toLowerCase();
  const scored = contentTopics.map((topic) => ({ ...topic, hits: topic.words.filter((word) => normalized.includes(word)) }))
    .sort((a, b) => b.hits.length - a.hits.length);
  const first = scored[0]!; const second = scored[1]!;
  if (first.hits.length < 2 || first.hits.length <= second.hits.length) return null;
  return { target: first.target, confidence: Math.min(0.95, 0.6 + first.hits.length * 0.06), reason: `본문 키워드: ${first.hits.join(', ')} (규칙 점수이며 정확도 측정치가 아닙니다)` };
}
