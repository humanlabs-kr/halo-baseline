import {
  BottleIcon,
  BreadIcon,
  EggIcon,
  NoodleIcon,
  SoapIcon,
  SugarIcon,
  WheatIcon,
} from '@/components/ui/icons';

/**
 * An icon per basket category.
 *
 * Twelve categories and seven icons: rice, beans and garri are all a dry
 * staple in a sack and the shopper reads the label, not the glyph. Inventing a
 * distinct silhouette for garri would be decoration pretending to be
 * information.
 *
 * Shared, so that the same item is the same icon in the same colour wherever
 * it appears — the market board, the group drill-down, anywhere a category is
 * listed. It lived inside the market board until the drill-down needed it and
 * had nothing at all.
 */
export function categoryIcon(category: string) {
  switch (category) {
    case 'rice':
    case 'beans':
    case 'garri':
      return <WheatIcon />;
    case 'eggs':
      return <EggIcon />;
    case 'cooking_oil':
    case 'milk_powder':
      return <BottleIcon />;
    case 'bread':
      return <BreadIcon />;
    case 'sugar':
    case 'tomato_paste':
      return <SugarIcon />;
    case 'noodles':
      return <NoodleIcon />;
    default:
      return <SoapIcon />;
  }
}

/**
 * The tile colour behind the icon.
 *
 * Two tints and a grey, assigned by what the thing is rather than by position
 * in the list — a shelf of staples in green and a shelf of everything else in
 * warm. Rotating the colours row by row would look livelier and would mean
 * nothing, and a reader who scrolls back would find the same item a different
 * colour.
 */
export function categoryTone(category: string): 'neutral' | 'saved' | 'warm' {
  switch (category) {
    case 'rice':
    case 'beans':
    case 'garri':
    case 'noodles':
      return 'saved';
    case 'eggs':
    case 'bread':
    case 'milk_powder':
      return 'warm';
    default:
      return 'neutral';
  }
}
