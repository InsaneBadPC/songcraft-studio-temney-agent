export function countText(value: string) {
  const lines = value ? value.split("\n").length : 0;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return { lines, words, chars: value.length };
}

function plural(count: number, one: string, few: string, many: string) {
  if (count === 1) return one;
  if (count >= 2 && count <= 4) return few;
  return many;
}

export function formatTextStats(value: string) {
  const { lines, words, chars } = countText(value);
  return `${lines} ${plural(lines, "řádek", "řádky", "řádků")} · ${words} ${plural(words, "slovo", "slova", "slov")} · ${chars} ${plural(chars, "znak", "znaky", "znaků")}`;
}
