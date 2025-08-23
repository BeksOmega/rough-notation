import {
  Rect,
  RoughAnnotationConfig,
  RoughAnnotation,
  SVG_NS,
  RoughAnnotationGroup,
  DEFAULT_ANIMATION_DURATION,
} from "./model.js";
import { renderAnnotation } from "./render.js";
import { ensureKeyframes } from "./keyframes.js";
import { randomSeed } from "roughjs/bin/math";

type AnnotationState = "unattached" | "not-showing" | "showing";

// Global batching system for resize handling
const dirtyAnnotations = new Set<RoughAnnotationImpl>();
let pendingUpdate = false;

function scheduleUpdate() {
  if (!pendingUpdate) {
    pendingUpdate = true;
    requestAnimationFrame(() => {
      // First pass: measure all dirty annotations in batch
      const annotationsToUpdate: {
        annotation: RoughAnnotationImpl;
        newRects: Rect[];
      }[] = [];

      for (const annotation of dirtyAnnotations) {
        if (annotation._state === "showing") {
          const newRects = annotation.measureRects();
          if (annotation.haveRectsChanged(newRects)) {
            annotationsToUpdate.push({ annotation, newRects });
          }
        }
      }

      // Second pass: update DOM for annotations that actually changed
      for (const { annotation, newRects } of annotationsToUpdate) {
        annotation.updateWithNewRects(newRects);
      }

      dirtyAnnotations.clear();
      pendingUpdate = false;
    });
  }
}

function markAnnotationDirty(annotation: RoughAnnotationImpl) {
  dirtyAnnotations.add(annotation);
  scheduleUpdate();
}

class RoughAnnotationImpl implements RoughAnnotation {
  _state: AnnotationState = "unattached"; // Made public for batching system
  private _config: RoughAnnotationConfig;
  private _ro?: any; // ResizeObserver is not supported in typescript std lib yet
  private _seed = randomSeed();

  private _e: HTMLElement;
  private _svg?: SVGSVGElement;
  private _lastSizes: Rect[] = [];

  _animationDelay = 0;

  constructor(e: HTMLElement, config: RoughAnnotationConfig) {
    this._e = e;
    this._config = JSON.parse(JSON.stringify(config));
    this.attach();
  }

  get animate() {
    return this._config.animate;
  }
  set animate(value) {
    this._config.animate = value;
  }

  get animationDuration() {
    return this._config.animationDuration;
  }
  set animationDuration(value) {
    this._config.animationDuration = value;
  }

  get animateOnHide() {
    return this._config.animateOnHide;
  }
  set animateOnHide(value) {
    this._config.animateOnHide = value;
  }

  get iterations() {
    return this._config.iterations;
  }
  set iterations(value) {
    this._config.iterations = value;
  }

  get color() {
    return this._config.color;
  }
  set color(value) {
    if (this._config.color !== value) {
      this._config.color = value;
      this.refresh();
    }
  }

  get strokeWidth() {
    return this._config.strokeWidth;
  }
  set strokeWidth(value) {
    if (this._config.strokeWidth !== value) {
      this._config.strokeWidth = value;
      this.refresh();
    }
  }

  get padding() {
    return this._config.padding;
  }
  set padding(value) {
    if (this._config.padding !== value) {
      this._config.padding = value;
      this.refresh();
    }
  }

  private _resizeListener = () => {
    markAnnotationDirty(this);
  };

  private attach() {
    if (this._state === "unattached" && this._e.parentElement) {
      ensureKeyframes();
      const svg = (this._svg = document.createElementNS(SVG_NS, "svg"));
      svg.setAttribute("class", "rough-annotation");
      const style = svg.style;
      style.position = "absolute";
      style.top = "0";
      style.left = "0";
      style.overflow = "visible";
      style.pointerEvents = "none";
      style.width = "100px";
      style.height = "100px";
      const prepend = this._config.type === "highlight";
      this._e.insertAdjacentElement(prepend ? "beforebegin" : "afterend", svg);
      this._state = "not-showing";

      // ensure e is positioned
      if (prepend) {
        const computedPos = window.getComputedStyle(this._e).position;
        const unpositioned = !computedPos || computedPos === "static";
        if (unpositioned) {
          this._e.style.position = "relative";
        }
      }
      this.attachListeners();
    }
  }

  private detachListeners() {
    window.removeEventListener("resize", this._resizeListener);
    if (this._ro) {
      this._ro.unobserve(this._e);
    }
  }

  private attachListeners() {
    this.detachListeners();
    window.addEventListener("resize", this._resizeListener, { passive: true });
    if (!this._ro && "ResizeObserver" in window) {
      this._ro = new (window as any).ResizeObserver((entries: any) => {
        for (const entry of entries) {
          if (entry.contentRect) {
            this._resizeListener();
          }
        }
      });
      this._ro.observe(this._e);
    }
  }

  measureRects(): Rect[] {
    const ret: Rect[] = [];
    if (this._svg) {
      if (this._config.multiline) {
        const elementRects = this._e.getClientRects();
        for (let i = 0; i < elementRects.length; i++) {
          ret.push(this.svgRect(this._svg, elementRects[i]));
        }
      } else {
        ret.push(this.svgRect(this._svg, this._e.getBoundingClientRect()));
      }
    }
    return ret;
  }

  haveRectsChanged(newRects?: Rect[]): boolean {
    const rectsToCompare = newRects || this.measureRects();
    if (this._lastSizes.length) {
      if (rectsToCompare.length === this._lastSizes.length) {
        for (let i = 0; i < rectsToCompare.length; i++) {
          if (!this.isSameRect(rectsToCompare[i], this._lastSizes[i])) {
            return true;
          }
        }
      } else {
        return true;
      }
    }
    return false;
  }

  private hasOnlyPositionChanged(newRects: Rect[]): boolean {
    if (this._lastSizes.length !== newRects.length) {
      return false;
    }

    const si = (a: number, b: number) => Math.round(a) === Math.round(b);
    let hasPositionChange = false;

    for (let i = 0; i < newRects.length; i++) {
      const oldRect = this._lastSizes[i];
      const newRect = newRects[i];

      // Check if size changed - if so, we can't use translation
      if (!si(oldRect.w, newRect.w) || !si(oldRect.h, newRect.h)) {
        return false;
      }

      // Check if position changed
      if (!si(oldRect.x, newRect.x) || !si(oldRect.y, newRect.y)) {
        hasPositionChange = true;
      }
    }

    // Only return true if position changed but size didn't
    return hasPositionChange;
  }

  private translateSVGContent(newRects: Rect[]): void {
    if (!this._svg || this._lastSizes.length === 0) return;

    if (newRects.length === 1 && this._lastSizes.length === 1) {
      // Single rect case (most common)
      const oldRect = this._lastSizes[0];
      const newRect = newRects[0];

      const deltaX = newRect.x - oldRect.x;
      const deltaY = newRect.y - oldRect.y;

      this.applyTranslationToAllPaths(deltaX, deltaY);
    } else if (newRects.length === this._lastSizes.length) {
      // Multi-rect case: calculate average translation
      // This works well for multiline text where all lines move together
      let totalDeltaX = 0;
      let totalDeltaY = 0;

      for (let i = 0; i < newRects.length; i++) {
        totalDeltaX += newRects[i].x - this._lastSizes[i].x;
        totalDeltaY += newRects[i].y - this._lastSizes[i].y;
      }

      const avgDeltaX = totalDeltaX / newRects.length;
      const avgDeltaY = totalDeltaY / newRects.length;

      // Only apply if all deltas are reasonably consistent (same direction/magnitude)
      const isConsistent = newRects.every((rect, i) => {
        const deltaX = rect.x - this._lastSizes[i].x;
        const deltaY = rect.y - this._lastSizes[i].y;
        return (
          Math.abs(deltaX - avgDeltaX) < 2 && Math.abs(deltaY - avgDeltaY) < 2
        );
      });

      if (isConsistent) {
        this.applyTranslationToAllPaths(avgDeltaX, avgDeltaY);
      } else {
        // Fall back to full re-render for complex multi-rect changes
        this.renderWithRects(this._svg, newRects, true);
        return;
      }
    }

    this._lastSizes = newRects;
  }

  private applyTranslationToAllPaths(deltaX: number, deltaY: number): void {
    if (!this._svg) return;

    const paths = this._svg.querySelectorAll("path");
    paths.forEach((path) => {
      const currentTransform = path.getAttribute("transform") || "";
      let newTransform = "";

      if (currentTransform.includes("translate")) {
        // Extract existing translate values and add deltas
        const translateMatch = currentTransform.match(/translate\(([^)]+)\)/);
        if (translateMatch) {
          const coords = translateMatch[1].split(/[,\s]+/).map(Number);
          const currentX = coords[0] || 0;
          const currentY = coords[1] || 0;

          newTransform = currentTransform.replace(
            /translate\([^)]+\)/,
            `translate(${currentX + deltaX}, ${currentY + deltaY})`
          );
        }
      } else {
        // Add new translate
        newTransform =
          `translate(${deltaX}, ${deltaY}) ${currentTransform}`.trim();
      }

      path.setAttribute("transform", newTransform);
    });
  }

  updateWithNewRects(newRects: Rect[]): void {
    if (this._state === "showing" && this._svg) {
      // Check if we can optimize with just a translation
      if (this.hasOnlyPositionChanged(newRects)) {
        this.translateSVGContent(newRects);
      } else {
        // Full re-render needed
        this.renderWithRects(this._svg, newRects, true);
      }
    }
  }

  private isSameRect(rect1: Rect, rect2: Rect): boolean {
    const si = (a: number, b: number) => Math.round(a) === Math.round(b);
    return (
      si(rect1.x, rect2.x) &&
      si(rect1.y, rect2.y) &&
      si(rect1.w, rect2.w) &&
      si(rect1.h, rect2.h)
    );
  }

  isShowing(): boolean {
    return this._state !== "not-showing";
  }

  private pendingRefresh?: Promise<void>;
  private refresh() {
    if (this.isShowing() && !this.pendingRefresh) {
      this.pendingRefresh = Promise.resolve().then(() => {
        if (this.isShowing()) {
          this.show();
        }
        delete this.pendingRefresh;
      });
    }
  }

  show(): void {
    switch (this._state) {
      case "unattached":
        break;
      case "showing":
        this.hide(/* force */ true);
        if (this._svg) {
          this.render(this._svg, true);
        }
        break;
      case "not-showing":
        this.attach();
        if (this._svg) {
          this.render(this._svg, false);
        }
        break;
    }
  }

  /**
   * @param force - If true, the annotation will be hidden immediately without animation.
   */
  hide(force?: boolean): void {
    if (!this.isShowing()) {
      return;
    }
    const animate = this.animateOnHide ?? false;
    if (this._svg && !force && animate) {
      const paths = Array.from(this._svg.querySelectorAll("path"));
      if (paths.length > 0) {
        const animationDuration =
          this._config.animationDuration || DEFAULT_ANIMATION_DURATION;
        const animationGroupDelay = this._animationDelay;
        const animations: (string | null)[] = [];
        const lengths: number[] = [];
        let totalLength = 0;

        for (const path of paths) {
          const style = path.style;
          const animation = style.animation;
          animations.push(animation);
          style.animation = "none";
          const length = path.getTotalLength();
          lengths.push(length);
          totalLength += length;
        }

        requestAnimationFrame(() => {
          let durationOffset = 0;
          for (let i = paths.length - 1; i >= 0; i--) {
            const path = paths[i];
            const animation = animations[i];
            if (animation) {
              const length = lengths[i];
              const duration = totalLength
                ? animationDuration * (length / totalLength)
                : 0;
              const delay = animationGroupDelay + durationOffset;
              const style = path.style;
              style.strokeDashoffset = "0";
              style.strokeDasharray = `${length}`;
              style.setProperty("--path-length", `${length}`);
              style.animation = `rough-notation-dash-reverse ${duration}ms ease-out ${delay}ms forwards`;
              durationOffset += duration;
            }
          }
        });

        const totalAnimationTime = animationDuration + animationGroupDelay;
        setTimeout(() => {
          paths.forEach((p) => {
            if (p.parentElement) {
              p.parentElement.removeChild(p);
            }
          });
        }, totalAnimationTime);
      }
    } else if (this._svg) {
      while (this._svg.lastChild) {
        this._svg.removeChild(this._svg.lastChild);
      }
    }
    this._state = "not-showing";
  }

  remove(): void {
    if (this._svg && this._svg.parentElement) {
      this._svg.parentElement.removeChild(this._svg);
    }
    this._svg = undefined;
    this._state = "unattached";
    this.detachListeners();
  }

  private render(svg: SVGSVGElement, ensureNoAnimation: boolean) {
    const rects = this.measureRects();
    this.renderWithRects(svg, rects, ensureNoAnimation);
  }

  private renderWithRects(
    svg: SVGSVGElement,
    rects: Rect[],
    ensureNoAnimation: boolean
  ) {
    // Clear existing paths first
    while (svg.lastChild) {
      svg.removeChild(svg.lastChild);
    }

    let config = this._config;
    if (ensureNoAnimation) {
      config = JSON.parse(JSON.stringify(this._config));
      config.animate = false;
    }
    let totalWidth = 0;
    rects.forEach((rect) => (totalWidth += rect.w));
    const totalDuration =
      config.animationDuration || DEFAULT_ANIMATION_DURATION;
    let delay = 0;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const ad = totalDuration * (rect.w / totalWidth);
      renderAnnotation(
        svg,
        rects[i],
        config,
        delay + this._animationDelay,
        ad,
        this._seed
      );
      delay += ad;
    }
    this._lastSizes = rects;
    this._state = "showing";
  }

  private svgRect(svg: SVGSVGElement, bounds: DOMRect | DOMRectReadOnly): Rect {
    const rect1 = svg.getBoundingClientRect();
    const rect2 = bounds;
    return {
      x: (rect2.x || rect2.left) - (rect1.x || rect1.left),
      y: (rect2.y || rect2.top) - (rect1.y || rect1.top),
      w: rect2.width,
      h: rect2.height,
    };
  }
}

export function annotate(
  element: HTMLElement,
  config: RoughAnnotationConfig
): RoughAnnotation {
  return new RoughAnnotationImpl(element, config);
}

export function annotationGroup(
  annotations: RoughAnnotation[]
): RoughAnnotationGroup {
  let delay = 0;
  for (const a of annotations) {
    const ai = a as RoughAnnotationImpl;
    ai._animationDelay = delay;
    const duration =
      ai.animationDuration === 0
        ? 0
        : ai.animationDuration || DEFAULT_ANIMATION_DURATION;
    delay += duration;
  }
  const list = [...annotations];
  return {
    show() {
      for (const a of list) {
        a.show();
      }
    },
    hide() {
      for (const a of list) {
        a.hide();
      }
    },
  };
}
