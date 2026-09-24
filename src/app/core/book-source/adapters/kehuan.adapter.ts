import { BaseSourceAdapter } from './base-source.adapter';
import { SOURCE_CONFIG } from '../book-source.config';

/** 科幻小说网 — utf-8 */
export class KehuanAdapter extends BaseSourceAdapter {
  readonly name = '科幻小说网';
  protected readonly hostPattern = /ke?huan\.(net\.cn|com)/;
  protected readonly config = SOURCE_CONFIG['kehuan'];
}
