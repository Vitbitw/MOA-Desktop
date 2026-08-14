// ─── 用量格式化工具（账单页 / 顶部条 / 悬浮窗三处共用）───
// 成本显示自适应精度：定价单位是 $/1M tokens，单次小请求成本可能低至 $0.0008，
// toFixed(2) 会显示成 $0.00；而大额（>= $1）保留两位小数更符合账单观感。

/** tokens 缩写：>=1000 显示 x.xk，否则原样 */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 成本格式化：USD 原样，CNY ×7.2；>=1 保留两位小数，小额用 3 位有效数字避免归零 */
export function formatCost(cost: number, currency: 'USD' | 'CNY'): string {
  const rate = currency === 'CNY' ? 7.2 : 1
  const symbol = currency === 'CNY' ? '¥' : '$'
  const v = cost * rate
  if (!v) return `${symbol}0`
  if (v >= 1) return `${symbol}${v.toFixed(2)}`
  return `${symbol}${Number(v.toPrecision(3)).toString()}`
}
