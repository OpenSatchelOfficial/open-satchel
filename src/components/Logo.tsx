import { Satchel } from './icons'

interface LogoProps {
  size?: number
  className?: string
}

/** Open Satchel brand mark.
 *
 *  Stack of three offset file sheets cinched by a shared baseline, with
 *  an accent-coloured editor nib in the upper-right. Reads as "many
 *  formats, one editor" — distinctly not the Acrobat A and not a
 *  literal satchel. The nib pulls --accent so the brand colour swaps
 *  with the user's accent preference. */
export default function Logo({ size = 22, className }: LogoProps) {
  return <Satchel size={size} style={className ? undefined : { color: 'currentColor' }} />
}
