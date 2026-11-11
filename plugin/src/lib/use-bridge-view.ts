// bridge 상태(BridgeView)를 React 상태로 구독한다.
import { useEffect, useState } from 'react';
import type { Bridge, BridgeView } from '../payment/bridge.ts';

export function useBridgeView(bridge: Bridge): BridgeView {
  const [view, setView] = useState<BridgeView>(() => bridge.getView());
  useEffect(() => {
    setView(bridge.getView());
    return bridge.subscribe(() => setView(bridge.getView()));
  }, [bridge]);
  return view;
}
