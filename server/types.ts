export type Destination = 'SHAH ALAM' | 'BUKIT RAJA';
export interface LineItem {
  part_number: string;
  item_code: string;
  pack_size: number;
  kanban_count: number;
  total_quantity: number;
}
export interface Extraction {
  source_order_id: string;
  destination: string;
  delivery_date: string;
  route: string;
  page_number: number;
  page_count: number;
  items: LineItem[];
}
export interface Order extends Omit<Extraction, 'destination'> {
  tagging_identity?: import('./taggingIdentity.ts').TaggingIdentity;
  destination: Destination;
  kb_number: string;
  delivery_sequence: string;
  trip: number;
  source_pages: string[];
  source_page_ids: string[];
}
export type PageState = 'pending' | 'extracting' | 'extracted' | 'error';
export interface Page {
  history_deleted?: boolean;
  id: string;
  file_id: string;
  filename: string;
  number: number;
  text: string;
  hash: string;
  state: PageState;
  extraction?: Extraction;
  error?: string;
}
export interface PeroduaOutput {
  entry_id?: string;
  dates?: import('./perodua-history.ts').PeroduaSavedDate[];
  save_date?: string;
  date_status?: 'open' | 'complete';
  trip_count?: number;
  missing_trip_count?: number;
  date?: import('./perodua-history.ts').PeroduaSavedDate;
  document_key?: string;
  document_keys?: string[];
  export_id?: string;
  generated_date?: string;
  created_at?: string;
  status: 'ready' | 'review' | 'extracted';
  pido: string;
  json_path: string;
  filename?: string;
  path?: string;
  document_count?: number;
  item_count?: number;
  error?: string;
}
export interface Upload {
  history_deleted?: boolean;
  id: string;
  filename: string;
  hash: string;
  size: number;
  path: string;
  error?: string;
  duplicate?: boolean;
  perodua?: PeroduaOutput;
  company?: 'PERODUA' | 'TOYOTA';
}
export interface Result {
  id: string;
  status: 'ready' | 'review' | 'saved';
  trip_count?: number;
  order_id: string;
  kb_number?: string;
  destination?: string;
  date?: string;
  dates?: string[];
  order_count?: number;
  order_numbers?: string[];
  filename?: string;
  path?: string;
  error?: string;
  sources: string[];
  source_page_ids?: string[];
}
export interface Job {
  perodua_entry_id?: string;
  perodua_date?: string;
  id: string;
  state:
    | 'queued'
    | 'reading'
    | 'processing'
    | 'generating'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'interrupted';
  stage: string;
  created_at: string;
  updated_at: string;
  attempt: string;
  files: Upload[];
  pages: Page[];
  results: Result[];
  error?: string;
}
export interface DispatchDate {
  id?: string;
  job_id?: string;
  filename?: string;
  exports?: { id: string; filename: string; created_at: string; order_count: number; trip_count: number }[];
  date: string;
  status: 'open' | 'complete';
  orders: Order[];
  updated_at: string;
  completed_at?: string;
  reopened_reason?: 'new_po' | 'manual';
  revision: number;
}
