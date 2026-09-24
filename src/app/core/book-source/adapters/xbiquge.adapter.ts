import { BaseSourceAdapter } from './base-source.adapter';
import { SOURCE_CONFIG } from '../book-source.config';

/** 笔趣阁（网文）— utf-8 */
export class XbiqugeAdapter extends BaseSourceAdapter {
  readonly name = '笔趣阁';
  protected readonly hostPattern = /xbiquge\.(cc|la|so)/;
  protected readonly config = SOURCE_CONFIG['xbiquge'];
}
