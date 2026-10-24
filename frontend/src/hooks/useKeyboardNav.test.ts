/**
 * useKeyboardNav.test.ts — Issue #101
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useKeyboardNav } from './useKeyboardNav'

function makeKeyEvent(key: string, shift = false): React.KeyboardEvent {
  return {
    key,
    shiftKey: shift,
    preventDefault: vi.fn(),
    currentTarget: document.createElement('div'),
  } as unknown as React.KeyboardEvent
}

describe('useKeyboardNav', () => {
  it('initialises with activeIndex 0', () => {
    const { result } = renderHook(() => useKeyboardNav({ count: 5 }))
    expect(result.current.activeIndex).toBe(0)
  })

  it('ArrowRight advances the index', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 5, orientation: 'horizontal' }),
    )
    const { getItemProps } = result.current
    act(() => {
      getItemProps(0).onKeyDown(makeKeyEvent('ArrowRight'))
    })
    expect(result.current.activeIndex).toBe(1)
  })

  it('ArrowLeft moves index backward', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 5, orientation: 'horizontal', initialIndex: 2 }),
    )
    act(() => {
      result.current.getItemProps(2).onKeyDown(makeKeyEvent('ArrowLeft'))
    })
    expect(result.current.activeIndex).toBe(1)
  })

  it('ArrowDown advances for vertical orientation', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 3, orientation: 'vertical' }),
    )
    act(() => {
      result.current.getItemProps(0).onKeyDown(makeKeyEvent('ArrowDown'))
    })
    expect(result.current.activeIndex).toBe(1)
  })

  it('wraps from last to first', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 3, orientation: 'horizontal', wrap: true }),
    )
    act(() => {
      result.current.setActiveIndex(2)
    })
    act(() => {
      result.current.getItemProps(2).onKeyDown(makeKeyEvent('ArrowRight'))
    })
    expect(result.current.activeIndex).toBe(0)
  })

  it('does not wrap past end when wrap=false', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 3, orientation: 'horizontal', wrap: false }),
    )
    act(() => {
      result.current.setActiveIndex(2)
    })
    act(() => {
      result.current.getItemProps(2).onKeyDown(makeKeyEvent('ArrowRight'))
    })
    expect(result.current.activeIndex).toBe(2)
  })

  it('Home jumps to first item', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 5, initialIndex: 3 }),
    )
    act(() => {
      result.current.getItemProps(3).onKeyDown(makeKeyEvent('Home'))
    })
    expect(result.current.activeIndex).toBe(0)
  })

  it('End jumps to last item', () => {
    const { result } = renderHook(() => useKeyboardNav({ count: 5 }))
    act(() => {
      result.current.getItemProps(0).onKeyDown(makeKeyEvent('End'))
    })
    expect(result.current.activeIndex).toBe(4)
  })

  it('Enter calls onActivate with the current index', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 5, onActivate, initialIndex: 2 }),
    )
    act(() => {
      result.current.getItemProps(2).onKeyDown(makeKeyEvent('Enter'))
    })
    expect(onActivate).toHaveBeenCalledWith(2)
  })

  it('Space calls onActivate with the current index', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 3, onActivate }),
    )
    act(() => {
      result.current.getItemProps(0).onKeyDown(makeKeyEvent(' '))
    })
    expect(onActivate).toHaveBeenCalledWith(0)
  })

  it('getItemProps sets tabIndex=0 for active item and -1 for others', () => {
    const { result } = renderHook(() =>
      useKeyboardNav({ count: 3, initialIndex: 1 }),
    )
    expect(result.current.getItemProps(0).tabIndex).toBe(-1)
    expect(result.current.getItemProps(1).tabIndex).toBe(0)
    expect(result.current.getItemProps(2).tabIndex).toBe(-1)
  })

  it('onFocus updates activeIndex', () => {
    const { result } = renderHook(() => useKeyboardNav({ count: 3 }))
    act(() => {
      result.current.getItemProps(2).onFocus()
    })
    expect(result.current.activeIndex).toBe(2)
  })
})
