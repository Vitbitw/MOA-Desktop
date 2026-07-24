import { create } from 'zustand'
import type { Provider, SubModelConfig, AggregatorConfig } from '../../../shared/types'

interface ConfigState {
  providers: Provider[]
  subModels: SubModelConfig[]
  aggregator: AggregatorConfig | null
  loading: boolean
  setProviders: (providers: Provider[]) => void
  setSubModels: (models: SubModelConfig[]) => void
  setAggregator: (config: AggregatorConfig | null) => void
  setLoading: (loading: boolean) => void
}

export const useConfigStore = create<ConfigState>((set) => ({
  providers: [],
  subModels: [],
  aggregator: null,
  loading: false,
  setProviders: (providers) => set({ providers }),
  setSubModels: (subModels) => set({ subModels }),
  setAggregator: (aggregator) => set({ aggregator }),
  setLoading: (loading) => set({ loading })
}))
