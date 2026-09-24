import { BaseSourceAdapter } from './base-source.adapter';
import { SOURCE_CONFIG } from '../book-source.config';

/** 读书人365（情怀）— gbk */
export class Readers365Adapter extends BaseSourceAdapter {
  readonly name = '读书人365';
  protected readonly hostPattern = /readers365\.com/;
  protected readonly config = SOURCE_CONFIG['readers365'];
}
