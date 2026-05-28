export type MetricPoint = {
  name: string
  value: number
  timestamp: string
  dimensions?: Record<string, string>
}

class MetricsStore {
  private points: MetricPoint[] = []
  private listeners = new Set<(points: MetricPoint[]) => void>()

  push(point: MetricPoint) {
    this.points = [...this.points.slice(-999), point]
    this.listeners.forEach((listener) => listener(this.points))
  }

  subscribe(listener: (points: MetricPoint[]) => void) {
    this.listeners.add(listener)
    listener(this.points)
    return () => this.listeners.delete(listener)
  }
}

export const metricsStore = new MetricsStore()
