export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---------- git times: seconds since the epoch plus the author's own UTC offset ('+0800') ----------
export const validTz = (tz: string) => /^[+-](0\d|1[0-4])[0-5]\d$/.test(tz)

export function tzMinutes(tz: string): number {
  const m = tz.match(/^([+-])(\d\d)(\d\d)$/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0
}

// The wall-clock time where the commit was made, as 'YYYY-MM-DDTHH:mm:ss' (for datetime-local).
export function toInput(time: number, tz: string): string {
  return new Date((time + tzMinutes(tz) * 60) * 1000).toISOString().slice(0, 19)
}

export function fromInput(value: string, tz: string): number {
  const ms = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`)
  return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000) - tzMinutes(tz) * 60
}

export const fmtTime = (time: number, tz: string) => toInput(time, tz).replace('T', ' ').slice(0, 16)

export const nowSeconds = () => Math.floor(Date.now() / 1000)

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
