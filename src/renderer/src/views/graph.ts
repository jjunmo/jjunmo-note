import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force'
import { h } from '../ui/dom'
import { Vault } from '../core/vault'
import type { App } from '../app'

interface GNode extends SimulationNodeDatum {
  id: string
  label: string
  resolved: boolean
  degree: number
  tags: string[]
}
type GLink = SimulationLinkDatum<GNode> & { source: GNode | string; target: GNode | string }

export interface GraphOptions {
  showOrphans: boolean
  showUnresolved: boolean
  showTags: boolean
  search: string
  depth: number
  linkDistance: number
  repel: number
}

export const DEFAULT_GRAPH: GraphOptions = {
  showOrphans: true,
  showUnresolved: false,
  showTags: false,
  search: '',
  depth: 1,
  linkDistance: 60,
  repel: 120
}

/** Force-directed note graph on a canvas with pan, zoom, drag and hover highlighting. */
export class GraphRenderer {
  canvas = h('canvas', { class: 'graph-canvas' })
  private ctx = this.canvas.getContext('2d')!
  private sim: Simulation<GNode, GLink> | null = null
  private nodes: GNode[] = []
  private links: GLink[] = []
  private neighbors = new Map<string, Set<string>>()
  private scale = 1
  private tx = 0
  private ty = 0
  private hover: GNode | null = null
  private drag: GNode | null = null
  private raf = 0
  private dpr = window.devicePixelRatio || 1
  private resizeObs: ResizeObserver
  private colors = { node: '#999', active: '#8b6cef', unresolved: '#666', tag: '#5ba56b', line: 'rgba(150,150,150,0.35)', text: '#ccc', bg: 'transparent' }

  constructor(
    private app: App,
    private opts: GraphOptions,
    private center: () => string | null
  ) {
    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(this.canvas)
    this.bindEvents()
  }

  private readColors() {
    const cs = getComputedStyle(document.body)
    const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f
    this.colors = {
      node: v('--graph-node', '#999'),
      active: v('--interactive-accent', '#8b6cef'),
      unresolved: v('--graph-node-unresolved', '#555'),
      tag: v('--graph-node-tag', '#5ba56b'),
      line: v('--graph-line', 'rgba(150,150,150,0.35)'),
      text: v('--text-muted', '#ccc'),
      bg: 'transparent'
    }
  }

  setOptions(o: Partial<GraphOptions>) {
    Object.assign(this.opts, o)
    this.rebuild()
  }

  rebuild() {
    this.readColors()
    const data = this.app.vault.graph()
    const prev = new Map(this.nodes.map((n) => [n.id, n]))
    let nodes: GNode[] = data.nodes
      .filter((n) => this.opts.showUnresolved || n.resolved)
      .map((n) => {
        const p = prev.get(n.id)
        return { id: n.id, label: n.resolved ? Vault.title(n.id) : n.id.replace(/^unresolved:/, ''), resolved: n.resolved, degree: 0, tags: n.tags, x: p?.x, y: p?.y, vx: p?.vx, vy: p?.vy }
      })
    const ids = new Set(nodes.map((n) => n.id))
    let links: GLink[] = data.links.filter((l) => ids.has(l.source) && ids.has(l.target)).map((l) => ({ ...l }))

    if (this.opts.showTags) {
      const tagNodes = new Map<string, GNode>()
      for (const n of [...nodes]) {
        for (const t of new Set(n.tags.map((x) => x.toLowerCase()))) {
          const id = 'tag:' + t
          if (!tagNodes.has(id)) tagNodes.set(id, { id, label: '#' + t, resolved: true, degree: 0, tags: [], x: prev.get(id)?.x, y: prev.get(id)?.y })
          links.push({ source: n.id, target: id })
        }
      }
      nodes = nodes.concat([...tagNodes.values()])
    }

    // Local graph: keep nodes within `depth` hops of the center.
    const center = this.center()
    if (center) {
      const adj = new Map<string, Set<string>>()
      for (const l of links) {
        const s = l.source as string
        const t = l.target as string
        if (!adj.has(s)) adj.set(s, new Set())
        if (!adj.has(t)) adj.set(t, new Set())
        adj.get(s)!.add(t)
        adj.get(t)!.add(s)
      }
      const keep = new Set([center])
      let frontier = [center]
      for (let d = 0; d < this.opts.depth; d++) {
        const next: string[] = []
        for (const id of frontier) for (const n of adj.get(id) ?? []) if (!keep.has(n)) keep.add(n), next.push(n)
        frontier = next
      }
      nodes = nodes.filter((n) => keep.has(n.id))
      links = links.filter((l) => keep.has(l.source as string) && keep.has(l.target as string))
    }

    const q = this.opts.search.trim().toLowerCase()
    if (q) {
      const match = new Set(nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id))
      nodes = nodes.filter((n) => match.has(n.id))
      links = links.filter((l) => match.has(l.source as string) && match.has(l.target as string))
    }

    this.neighbors = new Map()
    for (const l of links) {
      const s = l.source as string
      const t = l.target as string
      if (!this.neighbors.has(s)) this.neighbors.set(s, new Set())
      if (!this.neighbors.has(t)) this.neighbors.set(t, new Set())
      this.neighbors.get(s)!.add(t)
      this.neighbors.get(t)!.add(s)
    }
    for (const n of nodes) n.degree = this.neighbors.get(n.id)?.size ?? 0
    if (!this.opts.showOrphans && !center) nodes = nodes.filter((n) => n.degree > 0)

    this.nodes = nodes
    this.links = links
    this.sim?.stop()
    this.sim = forceSimulation<GNode, GLink>(nodes)
      .force('link', forceLink<GNode, GLink>(links).id((d) => d.id).distance(this.opts.linkDistance).strength(0.4))
      .force('charge', forceManyBody().strength(-this.opts.repel))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.04))
      .force('y', forceY(0).strength(0.04))
      .force('collide', forceCollide<GNode>((d) => this.radius(d) + 2))
      .alpha(prev.size ? 0.3 : 1)
      .on('tick', () => this.requestDraw())
    this.requestDraw()
  }

  private radius(n: GNode) {
    return 3 + Math.sqrt(n.degree) * 1.6
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect()
    if (!r.width || !r.height) return
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = r.width * this.dpr
    this.canvas.height = r.height * this.dpr
    this.requestDraw()
  }

  private requestDraw() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  private toWorld(cx: number, cy: number) {
    const r = this.canvas.getBoundingClientRect()
    return { x: (cx - r.left - r.width / 2 - this.tx) / this.scale, y: (cy - r.top - r.height / 2 - this.ty) / this.scale }
  }

  private nodeAt(cx: number, cy: number): GNode | null {
    const p = this.toWorld(cx, cy)
    let best: GNode | null = null
    let bestD = Infinity
    for (const n of this.nodes) {
      const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y)
      if (d < this.radius(n) + 4 / this.scale && d < bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }

  private draw() {
    const { ctx, canvas } = this
    const w = canvas.width / this.dpr
    const hgt = canvas.height / this.dpr
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, w, hgt)
    ctx.translate(w / 2 + this.tx, hgt / 2 + this.ty)
    ctx.scale(this.scale, this.scale)
    const focus = this.hover ?? this.drag
    const near = focus ? this.neighbors.get(focus.id) : null
    const center = this.center()

    ctx.lineWidth = 1 / this.scale
    for (const l of this.links) {
      const s = l.source as GNode
      const t = l.target as GNode
      const hl = focus && (s === focus || t === focus)
      ctx.strokeStyle = hl ? this.colors.active : this.colors.line
      ctx.globalAlpha = focus && !hl ? 0.15 : 1
      ctx.beginPath()
      ctx.moveTo(s.x ?? 0, s.y ?? 0)
      ctx.lineTo(t.x ?? 0, t.y ?? 0)
      ctx.stroke()
    }
    for (const n of this.nodes) {
      const dim = focus && n !== focus && !near?.has(n.id)
      ctx.globalAlpha = dim ? 0.2 : 1
      ctx.fillStyle = n === focus || n.id === center ? this.colors.active : n.id.startsWith('tag:') ? this.colors.tag : n.resolved ? this.colors.node : this.colors.unresolved
      ctx.beginPath()
      ctx.arc(n.x ?? 0, n.y ?? 0, this.radius(n), 0, Math.PI * 2)
      ctx.fill()
    }
    // Labels fade in when zoomed or highlighted.
    const fontSize = 12 / Math.max(this.scale, 0.6)
    ctx.font = `${fontSize}px var(--font-interface, sans-serif)`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of this.nodes) {
      const highlighted = n === focus || near?.has(n.id)
      const alpha = highlighted ? 1 : focus ? 0.1 : Math.min(1, Math.max(0, (this.scale - 0.6) * 2))
      if (alpha <= 0.02) continue
      ctx.globalAlpha = alpha
      ctx.fillStyle = this.colors.text
      ctx.fillText(n.label, n.x ?? 0, (n.y ?? 0) + this.radius(n) + 3)
    }
    ctx.globalAlpha = 1
  }

  private bindEvents() {
    let panning = false
    let moved = false
    let last = { x: 0, y: 0 }
    this.canvas.addEventListener('mousedown', (e) => {
      moved = false
      const n = this.nodeAt(e.clientX, e.clientY)
      last = { x: e.clientX, y: e.clientY }
      if (n) {
        this.drag = n
        n.fx = n.x
        n.fy = n.y
        this.sim?.alphaTarget(0.3).restart()
      } else panning = true
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - last.x
        const dy = ev.clientY - last.y
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
        last = { x: ev.clientX, y: ev.clientY }
        if (this.drag) {
          const p = this.toWorld(ev.clientX, ev.clientY)
          this.drag.fx = p.x
          this.drag.fy = p.y
        } else if (panning) {
          this.tx += dx
          this.ty += dy
          this.requestDraw()
        }
      }
      const up = (ev: MouseEvent) => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        if (this.drag) {
          const node = this.drag
          node.fx = null
          node.fy = null
          this.sim?.alphaTarget(0)
          this.drag = null
          if (!moved) this.openNode(node, ev.metaKey || ev.ctrlKey)
        }
        panning = false
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.drag) return
      const n = this.nodeAt(e.clientX, e.clientY)
      if (n !== this.hover) {
        this.hover = n
        this.canvas.style.cursor = n ? 'pointer' : 'default'
        this.requestDraw()
      }
    })
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null
      this.requestDraw()
    })
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = this.canvas.getBoundingClientRect()
        const mx = e.clientX - r.left - r.width / 2
        const my = e.clientY - r.top - r.height / 2
        const factor = Math.exp(-e.deltaY * 0.0015)
        const next = Math.min(6, Math.max(0.1, this.scale * factor))
        this.tx = mx - ((mx - this.tx) * next) / this.scale
        this.ty = my - ((my - this.ty) * next) / this.scale
        this.scale = next
        this.requestDraw()
      },
      { passive: false }
    )
  }

  private openNode(n: GNode, newTab: boolean) {
    if (n.id.startsWith('tag:')) this.app.searchFor(`tag:#${n.id.slice(4)}`)
    else if (n.id.startsWith('unresolved:')) this.app.openLink(n.id.slice('unresolved:'.length), '', '', newTab)
    else this.app.openFile(n.id, { newTab })
  }

  destroy() {
    this.sim?.stop()
    this.resizeObs.disconnect()
    cancelAnimationFrame(this.raf)
  }
}
