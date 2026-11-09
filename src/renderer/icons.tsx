/**
 * Solar Linear icons (480 Design, CC BY 4.0; https://www.streamlinehq.com/icons/solar-linear).
 * Paths copied verbatim from the Solar set (24x24 grid, 1.5 px round strokes) so every icon in
 * the app shares one style. Icons are decorative (aria-hidden); the button carries the label.
 */
interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Solar "Pen 2" (rename). */
export function PenIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 22H20" />
      <path d="M13.8881 3.66293L14.6296 2.92142C15.8581 1.69286 17.85 1.69286 19.0786 2.92142C20.3071 4.14999 20.3071 6.14188 19.0786 7.37044L18.3371 8.11195M13.8881 3.66293C13.8881 3.66293 13.9807 5.23862 15.3711 6.62894C16.7614 8.01926 18.3371 8.11195 18.3371 8.11195M13.8881 3.66293L7.07106 10.4799C6.60933 10.9416 6.37846 11.1725 6.17992 11.4271C5.94571 11.7273 5.74491 12.0522 5.58107 12.396C5.44219 12.6874 5.33894 12.9972 5.13245 13.6167L4.25745 16.2417M4.25745 16.2417L4.04356 16.8833C3.94194 17.1882 4.02128 17.5243 4.2485 17.7515C4.47573 17.9787 4.81182 18.0581 5.11667 17.9564L5.75834 17.7426L8.38334 16.8675C9.00282 16.6611 9.31256 16.5578 9.60398 16.4189C9.94775 16.2551 10.2727 16.0543 10.5729 15.8201C10.8275 15.6215 11.0584 15.3907 11.5201 14.9289L18.3371 8.11195M5.75834 17.7426L4.25745 16.2417" />
    </Svg>
  )
}

/** Solar "Trash Bin Minimalistic" (delete). */
export function TrashIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.1709 4C9.58273 2.83481 10.694 2 12.0002 2C13.3064 2 14.4177 2.83481 14.8295 4" />
      <path d="M20.5001 6H3.5" />
      <path d="M18.8332 8.5L18.3732 15.3991C18.1962 18.054 18.1077 19.3815 17.2427 20.1907C16.3777 21 15.0473 21 12.3865 21H11.6132C8.95235 21 7.62195 21 6.75694 20.1907C5.89194 19.3815 5.80344 18.054 5.62644 15.3991L5.1665 8.5" />
      <path d="M9.5 11L10 16" />
      <path d="M14.5 11L14 16" />
    </Svg>
  )
}

/** Solar "Magnifer" (search). */
export function SearchIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11.5" cy="11.5" r="9.5" />
      <path d="M18.2173 18.2178L21.9999 22.0004" />
    </Svg>
  )
}

/** Solar "Alt Arrow Down" (dropdowns). */
export function ChevronDownIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M19 9L12 15L5 9" />
    </Svg>
  )
}

/** Solar "Eye" (item shown). */
export function EyeIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M3.27489 15.2957C2.42496 14.1915 2 13.6394 2 12C2 10.3606 2.42496 9.80853 3.27489 8.70433C4.97196 6.49956 7.81811 4 12 4C16.1819 4 19.028 6.49956 20.7251 8.70433C21.575 9.80853 22 10.3606 22 12C22 13.6394 21.575 14.1915 20.7251 15.2957C19.028 17.5004 16.1819 20 12 20C7.81811 20 4.97196 17.5004 3.27489 15.2957Z" />
      <path d="M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z" />
    </Svg>
  )
}

/** Solar "Eye Closed" (item hidden). */
export function EyeClosedIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 14C5 14 2 7 2 7M22 7C22 7 21.0586 9.19661 19 11.1288C18.0872 11.9856 16.9547 12.7904 15.5872 13.3287C14.5334 13.7435 13.34 14 12 14M12 14V16.5M15.5872 13.3287L17 15.5M19 11.1288L20.5 12.6288M8.41281 13.3287L7 15.5M5 11.1288L3.5 12.6288" />
    </Svg>
  )
}

/** Solar "Close Circle" (remove a symbol). */
export function CloseCircleIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M14.5 9.50002L9.5 14.5M9.49998 9.5L14.5 14.5" />
    </Svg>
  )
}

/** Solar "Add Circle" (create / add). */
export function AddCircleIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M15 12L12 12M12 12L9 12M12 12L12 9M12 12L12 15" />
    </Svg>
  )
}

/** Solar "Hamburger Menu" (drag handle). */
export function DragHandleIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M20 7L4 7" />
      <path d="M20 12L4 12" />
      <path d="M20 17L4 17" />
    </Svg>
  )
}

/** Solar "Checklist Minimalistic" (Watchlists tab). */
export function ChecklistIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2 12C2 7.28595 2 4.92893 3.46447 3.46447C4.92893 2 7.28595 2 12 2C16.714 2 19.0711 2 20.5355 3.46447C22 4.92893 22 7.28595 22 12C22 16.714 22 19.0711 20.5355 20.5355C19.0711 22 16.714 22 12 22C7.28595 22 4.92893 22 3.46447 20.5355C2 19.0711 2 16.714 2 12Z" />
      <path d="M6 15.8L7.14286 17L10 14" />
      <path d="M6 8.8L7.14286 10L10 7" />
      <path d="M13 9L18 9" />
      <path d="M13 16L18 16" />
    </Svg>
  )
}

/** Solar "Tuning 2" (Preferences tab). */
export function TuningIcon(p: IconProps): React.JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.5 14C11.1569 14 12.5 15.3431 12.5 17C12.5 18.6568 11.1569 20 9.5 20C7.84315 20 6.5 18.6568 6.5 17C6.5 15.3431 7.84315 14 9.5 14Z" />
      <path d="M14.5 3.99998C12.8431 3.99998 11.5 5.34312 11.5 6.99998C11.5 8.65683 12.8431 9.99998 14.5 9.99998C16.1569 9.99998 17.5 8.65683 17.5 6.99998C17.5 5.34312 16.1569 3.99998 14.5 3.99998Z" />
      <path d="M15 16.9585L22 16.9585" />
      <path d="M9 6.9585L2 6.9585" />
      <path d="M2 16.9585L4 16.9585" />
      <path d="M22 6.9585L20 6.9585" />
    </Svg>
  )
}
