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
  destination: Destination;
  kb_number: string;
  trip: number;
  source_pages: string[];
  source_page_ids: string[];
}
export type PageState = 'pending' | 'extracting' | 'extracted' | 'error';
export interface Page {
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
export interface Upload {
  id: string;
  filename: string;
  hash: string;
  size: number;
  path: string;
  error?: string;
  duplicate?: boolean;
}
export interface Result {
  id: string;
  status: 'ready' | 'review';
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
