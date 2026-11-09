import { useEffect, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { t } from '../../shared/i18n'
import type { Instrument, InstrumentId, Language, Watchlist, WatchlistItem } from '../../shared/types'
import { CloseCircleIcon, DragHandleIcon, EyeClosedIcon, EyeIcon } from '../icons'
import type { Run } from './Settings'
import styles from './ItemList.module.css'

interface ItemListProps {
  watchlist: Watchlist
  instruments: Record<InstrumentId, Instrument>
  run: Run
  lang: Language
}

function Row({
  item,
  instrument,
  watchlistId,
  run,
  lang
}: {
  item: WatchlistItem
  instrument: Instrument | undefined
  watchlistId: string
  run: Run
  lang: Language
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })
  const symbol = instrument?.displaySymbol ?? item.id
  const name = instrument ? (lang === 'vi' ? instrument.nameVi : instrument.nameEn) : ''
  const market = instrument?.market ?? (item.id.split(':')[0] as Instrument['market'])
  return (
    <li
      ref={setNodeRef}
      className={`${styles.row} ${isDragging ? styles.dragging : ''} ${item.hidden ? styles.hidden : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="item-row"
      data-id={item.id}
      data-hidden={item.hidden ? 'true' : 'false'}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className={styles.handle}
        data-testid="drag-handle"
        aria-label={t(lang, 'settings.items.drag', { symbol })}
        {...attributes}
        {...listeners}
      >
        <DragHandleIcon size={16} />
      </button>
      <div className={styles.info}>
        <span className={styles.symbol}>{symbol}</span>
        <span className={styles.name}>{name}</span>
      </div>
      <span className={styles.badge}>{t(lang, `market.${market}`)}</span>
      <button
        type="button"
        className={styles.icon}
        data-testid="toggle-hidden"
        aria-pressed={!item.hidden}
        aria-label={t(lang, 'settings.items.show', { symbol })}
        title={t(lang, item.hidden ? 'settings.items.show' : 'settings.items.hide', { symbol })}
        onClick={() => void run({ type: 'setHidden', watchlistId, id: item.id, hidden: !item.hidden })}
      >
        {item.hidden ? <EyeClosedIcon size={16} /> : <EyeIcon size={16} />}
      </button>
      <button
        type="button"
        className={styles.icon}
        data-testid="remove-item"
        aria-label={t(lang, 'settings.items.remove', { symbol })}
        title={t(lang, 'settings.items.remove', { symbol })}
        onClick={() => void run({ type: 'removeItem', watchlistId, id: item.id })}
      >
        <CloseCircleIcon size={16} />
      </button>
    </li>
  )
}

export function ItemList({ watchlist, instruments, run, lang }: ItemListProps): React.JSX.Element {
  // Local order so a drop renders immediately; resynced from settings.
  const [order, setOrder] = useState(watchlist.items)
  useEffect(() => setOrder(watchlist.items), [watchlist.items])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const from = order.findIndex((i) => i.id === active.id)
    const to = order.findIndex((i) => i.id === over.id)
    if (from < 0 || to < 0) return
    setOrder(arrayMove(order, from, to))
    void run({ type: 'moveItem', watchlistId: watchlist.id, from, to })
  }

  if (order.length === 0) {
    return (
      <p className={styles.empty} data-testid="items-empty">
        {t(lang, 'settings.items.empty')}
      </p>
    )
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <ul className={styles.list} data-testid="items" aria-label={t(lang, 'settings.items.title')}>
          {order.map((item) => (
            <Row
              key={item.id}
              item={item}
              instrument={instruments[item.id]}
              watchlistId={watchlist.id}
              run={run}
              lang={lang}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}
