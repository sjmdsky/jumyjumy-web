import { describe, test, expect } from 'vitest'
import { formatTimestamp } from '../datetime'

// 2026-08-29T09:05:03Z
const TS = Date.UTC(2026, 7, 29, 9, 5, 3)

describe('formatTimestamp', () => {
  test('formats to the second in UTC by default', () => {
    // Arrange / Act — 服务端不知道访客时区，默认 UTC 保证同一份 HTML 可被边缘缓存
    const formatted = formatTimestamp(TS)

    // Assert
    expect(formatted).toBe('Aug 29, 2026, 09:05:03 UTC')
  })

  test('renders the same instant in a requested time zone', () => {
    // Act
    const formatted = formatTimestamp(TS, 'Asia/Shanghai')

    // Assert
    expect(formatted).toBe('Aug 29, 2026, 17:05:03 GMT+8')
  })

  test('uses a 24-hour clock so 13:00 is not rendered as 1 PM', () => {
    // Act
    const formatted = formatTimestamp(Date.UTC(2026, 7, 29, 13, 0, 0))

    // Assert
    expect(formatted).toContain('13:00:00')
    expect(formatted).not.toMatch(/[AP]M/)
  })

  test('zero-pads hours, minutes and seconds', () => {
    // Act
    const formatted = formatTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))

    // Assert
    expect(formatted).toBe('Jan 2, 2026, 03:04:05 UTC')
  })

  test('always names the zone so a server-rendered time is not mistaken for local time', () => {
    // Arrange — 无 JS 时页面停在服务端渲染的 UTC 上，不标注时区就是在骗人
    // Act / Assert
    expect(formatTimestamp(TS)).toMatch(/UTC$/)
    expect(formatTimestamp(TS, 'America/New_York')).toMatch(/EDT$/)
  })

  test('falls back to UTC when the time zone is not recognized', () => {
    // Arrange — 时区来自浏览器，属于边界输入；Intl 对非法值直接抛 RangeError
    // Act
    const formatted = formatTimestamp(TS, 'Not/AZone')

    // Assert
    expect(formatted).toBe('Aug 29, 2026, 09:05:03 UTC')
  })
})
