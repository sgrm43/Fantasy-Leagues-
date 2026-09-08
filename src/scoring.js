const STAT_ALIASES = {
  passYards: ['passYards', 'PY'], passTd: ['passTd', 'PTD'], interceptions: ['interceptions', 'INT'],
  rushYards: ['rushYards', 'RY'], rushTd: ['rushTd', 'RTD'], receptions: ['receptions', 'REC'],
  receivingYards: ['receivingYards', 'REY'], receivingTd: ['receivingTd', 'RETD'],
  fumblesLost: ['fumblesLost', 'FUML']
};

export function scoreStats(stats, rules) {
  let total = 0;
  const breakdown = [];
  for (const [canonical, aliases] of Object.entries(STAT_ALIASES)) {
    const value = Number(stats[canonical] ?? 0);
    const ruleKey = aliases.find((key) => rules[key] != null);
    if (!ruleKey || !value) continue;
    const points = value * Number(rules[ruleKey]);
    total += points;
    breakdown.push({ stat: canonical, value, rate: Number(rules[ruleKey]), points });
  }
  for (const bonus of rules.bonuses || []) {
    const value = Number(stats[bonus.stat] ?? 0);
    if (value >= bonus.threshold) {
      total += Number(bonus.points);
      breakdown.push({ stat: bonus.stat, value, threshold: bonus.threshold, points: Number(bonus.points), bonus: true });
    }
  }
  return { total: Math.round(total * 100) / 100, breakdown };
}

export function scoreSleeperProjection(stats, rawRules) {
  let total = 0;
  const breakdown = [];
  const used = new Set();
  for (const [stat, value] of Object.entries(stats || {})) {
    if (!Number.isFinite(Number(value)) || rawRules[stat] == null || stat.startsWith('bonus_')) continue;
    const points = Number(value) * Number(rawRules[stat]);
    if (points) breakdown.push({ stat, value: Number(value), rate: Number(rawRules[stat]), points: round(points) });
    total += points; used.add(stat);
  }
  const thresholdStats = { pass_yd: 'pass_yd', rush_yd: 'rush_yd', rec_yd: 'rec_yd', rush_rec_yd: ['rush_yd', 'rec_yd'], pass_cmp: 'pass_cmp', rush_att: 'rush_att' };
  for (const [rule, points] of Object.entries(rawRules || {})) {
    const match = /^bonus_(pass_yd|rush_yd|rec_yd|rush_rec_yd|pass_cmp|rush_att)_(\d+)$/.exec(rule);
    if (!match) continue;
    const source = thresholdStats[match[1]];
    const value = (Array.isArray(source) ? source : [source]).reduce((sum, key) => sum + Number(stats?.[key] || 0), 0);
    const threshold = Number(match[2]);
    if (value >= threshold) { total += Number(points); breakdown.push({ stat: match[1], value, threshold, points: Number(points), bonus: true }); }
  }
  return { total: round(total), breakdown };
}

export function summarizeSamples(samples, rules, thresholds = []) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('At least two statistical samples are required');
  const values = samples.map((sample) => scoreStats(sample, rules).total).sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const quantile = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return {
    samples: values.length, mean: round(mean), median: quantile(0.5), floor: quantile(0.2), ceiling: quantile(0.8),
    bustProbability: round(values.filter((x) => x < mean * 0.6).length / values.length),
    spikeProbability: round(values.filter((x) => x > mean * 1.4).length / values.length),
    thresholds: thresholds.map((threshold) => ({ threshold, probability: round(values.filter((x) => x >= threshold).length / values.length) }))
  };
}

const round = (value) => Math.round(value * 1000) / 1000;
