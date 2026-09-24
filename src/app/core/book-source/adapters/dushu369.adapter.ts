import { BaseSourceAdapter } from './base-source.adapter';
import { SOURCE_CONFIG } from '../book-source.config';

/** 读书369（名著）— gbk */
export class Dushu369Adapter extends BaseSourceAdapter {
  readonly name = '读书369';
  protected readonly hostPattern = /dushu369\.com/;
  protected readonly config = SOURCE_CONFIG['dushu369'];
}
