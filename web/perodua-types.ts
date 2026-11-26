export type PeroduaDocument = {
  key: string; source_file: string; pido: string; delivery_date: string; delivery_time: string;
  item_count: number; exported: boolean; codes: string[]; missing_models: string[]; delivery_trip?: number | null;
};
