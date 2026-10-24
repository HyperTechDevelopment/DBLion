import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance
} from '@xyflow/react'
import { Maximize2, Network, RefreshCw, Search, Table2 } from 'lucide-react'
import type { ColumnInfo, SchemaGraph } from '@shared/types'

type TableNodeData = {
  label: string
  schema?: string
  columns: ColumnInfo[]
  primaryKeys: number
}

type TableNode = Node<TableNodeData, 'table'>

function TableNodeView({ data }: NodeProps<TableNode>) {
  const visibleColumns = data.columns.slice(0, 12)
  const hiddenCount = Math.max(0, data.columns.length - visibleColumns.length)

  return (
    <div className="graph-node">
      <Handle type="target" position={Position.Left} className="graph-node-handle" />
      <div className="graph-node-header">
        <span className="graph-node-title">
          <Table2 size={13} />
          {data.label}
        </span>
        <span className="graph-node-schema">
          {data.schema ?? 'table'}
          {data.primaryKeys > 0 ? ` · ${data.primaryKeys} PK` : ''}
        </span>
      </div>
      <div className="graph-node-columns">
        {visibleColumns.length === 0 ? (
          <div className="graph-column">
            <span className="col-name">no columns</span>
          </div>
        ) : (
          visibleColumns.map((column) => (
            <div key={column.name} className={`graph-column ${column.primaryKey ? 'pk' : ''}`}>
              <span className="col-name">{column.name}</span>
              <span className="col-type">{column.type}</span>
            </div>
          ))
        )}
        {hiddenCount > 0 ? (
          <div className="graph-column graph-column--more">+{hiddenCount} more</div>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="graph-node-handle" />
    </div>
  )
}

const nodeTypes = { table: TableNodeView }

interface Props {
  graph: SchemaGraph | null
  loading: boolean
  onRefresh: () => void
}

export default function ErGraph({ graph, loading, onRefresh }: Props) {
  const [query, setQuery] = useState('')
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null)

  const initialNodes = useMemo<Node[]>(() => {
    if (!graph) return []
    const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)))
    return graph.nodes.map((node, index) => ({
      id: node.id,
      type: 'table',
      position: {
        x: (index % columns) * 320,
        y: Math.floor(index / columns) * 320
      },
      data: {
        label: node.label,
        schema: node.schema,
        columns: node.columns,
        primaryKeys: node.columns.filter((column) => column.primaryKey).length
      }
    }))
  }, [graph])

  const initialEdges = useMemo<Edge[]>(() => {
    if (!graph) return []
    return graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: 'var(--border-strong)', strokeWidth: 1.3 },
      labelStyle: { fill: 'var(--muted)', fontSize: 10 },
      labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.92 }
    }))
  }, [graph])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleNodes = normalizedQuery
    ? nodes.map((node) => ({
        ...node,
        hidden: !`${node.data.label} ${node.data.schema ?? ''}`.toLowerCase().includes(normalizedQuery)
      }))
    : nodes
  const hiddenIds = new Set(visibleNodes.filter((node) => node.hidden).map((node) => node.id))
  const visibleEdges = normalizedQuery
    ? edges.map((edge) => ({
        ...edge,
        hidden: hiddenIds.has(edge.source) || hiddenIds.has(edge.target)
      }))
    : edges

  return (
    <div className="graph-shell">
      <div className="graph-toolbar">
        <div className="graph-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a table…"
            aria-label="Find a table in the ER graph"
          />
        </div>
        <button className="btn" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={14} /> {loading ? 'Building…' : 'Refresh'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => instance?.fitView({ padding: 0.2 })}
          disabled={!graph}
        >
          <Maximize2 size={14} /> Fit
        </button>
        <span className="chip">
          {graph ? `${graph.nodes.length} tables · ${graph.edges.length} FKs` : 'no graph'}
        </span>
      </div>

      {graph && graph.nodes.length > 0 ? (
        <ReactFlow
          nodes={visibleNodes}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setInstance}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.12}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--border)" gap={26} size={1} />
          <Controls />
          <MiniMap
            pannable
            zoomable
            style={{ background: 'var(--panel)' }}
            nodeColor="var(--accent)"
            maskColor="rgba(0,0,0,0.35)"
          />
        </ReactFlow>
      ) : (
        <div className="empty-state">
          <div className="empty-state__icon">
            <Network size={20} />
          </div>
          <strong>No ER graph yet</strong>
          <span>
            Connect to a database and refresh to build the table, column and foreign-key map. MongoDB
            and Redis show collection/key maps instead of foreign keys.
          </span>
          <button className="btn btn-primary" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} /> {loading ? 'Building…' : 'Build graph'}
          </button>
        </div>
      )}
    </div>
  )
}
