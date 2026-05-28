import { type CSSProperties, useMemo } from 'react'

type VirtualListProps<T> = {
  items: readonly T[]
  height: number
  itemHeight: number
  scrollTop: number
  renderItem: (item: T, index: number) => JSX.Element
}

export const VirtualList = <T,>({ items, height, itemHeight, scrollTop, renderItem }: VirtualListProps<T>) => {
  const range = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - 4)
    const visibleCount = Math.ceil(height / itemHeight) + 8
    return { start, end: Math.min(items.length, start + visibleCount) }
  }, [height, itemHeight, items.length, scrollTop])

  const spacerStyle: CSSProperties = { height: items.length * itemHeight, position: 'relative' }
  const sliceStyle: CSSProperties = { transform: `translateY(${range.start * itemHeight}px)` }

  return (
    <div style={{ height, overflow: 'auto' }}>
      <div style={spacerStyle}>
        <div style={sliceStyle}>{items.slice(range.start, range.end).map((item, offset) => renderItem(item, range.start + offset))}</div>
      </div>
    </div>
  )
}
