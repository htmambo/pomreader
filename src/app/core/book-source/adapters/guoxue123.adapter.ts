import { BaseSourceAdapter } from './base-source.adapter';
import { SOURCE_CONFIG } from '../book-source.config';

/** 国学123（国学）— gbk */
export class Guoxue123Adapter extends BaseSourceAdapter {
  readonly name = '国学123';
  protected readonly hostPattern = /guoxue123\.com/;
  protected readonly config = SOURCE_CONFIG['guoxue123'];
}
