const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function field(value, min, max) {
  const result = new Set()
  if (value === '*') {
    for (let n = min; n <= max; n += 1) result.add(n)
    return result
  }
  for (const part of value.split(',')) {
    const [base, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return undefined
    let low; let high
    if (base === '*') [low, high] = [min, max]
    else if (/^\d+$/.test(base)) [low, high] = [Number(base), Number(base)]
    else if (/^\d+-\d+$/.test(base)) [low, high] = base.split('-').map(Number)
    else return undefined
    if (low < min || high > max || low > high) return undefined
    for (let n = low; n <= high; n += step) result.add(n)
  }
  return result
}

export function parseCron(expression) {
  if (typeof expression !== 'string') return undefined
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const sets = parts.map((value, index) => field(value, ...RANGES[index]))
  if (sets.some(value => value === undefined)) return undefined
  return {
    minutes: sets[0], hours: sets[1], days: sets[2], months: sets[3],
    weekdays: new Set([...sets[4]].map(value => value === 7 ? 0 : value)),
    dayWildcard: parts[2] === '*', weekdayWildcard: parts[4] === '*',
  }
}

export function isValidCron(expression) { return parseCron(expression) !== undefined }

function matches(schedule, date) {
  if (!schedule.minutes.has(date.getMinutes()) || !schedule.hours.has(date.getHours())) return false
  if (!schedule.months.has(date.getMonth() + 1)) return false
  const day = schedule.days.has(date.getDate())
  const weekday = schedule.weekdays.has(date.getDay())
  if (schedule.dayWildcard) return weekday
  if (schedule.weekdayWildcard) return day
  return day || weekday
}

export function nextRunAtMs(expression, fromMs = Date.now()) {
  const schedule = parseCron(expression)
  if (!schedule) return undefined
  const date = new Date(fromMs)
  const cursor = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes() + 1)
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000
  while (cursor.getTime() <= limit) {
    if (matches(schedule, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return undefined
}

export function nextIntervalMs(anchorMs, minutes, nowMs = Date.now()) {
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  const step = Math.round(minutes) * 60_000
  let next = (Number.isFinite(anchorMs) ? anchorMs : nowMs) + step
  if (next <= nowMs) next += Math.ceil((nowMs - next + 1) / step) * step
  return next
}
