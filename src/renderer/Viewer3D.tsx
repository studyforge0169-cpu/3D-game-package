/**
 * Interactive 3D viewer (spec §6).
 *
 * Formats: GLB/GLTF (GLTFLoader), OBJ, STL, PLY, FBX, DAE (Collada) via the
 * official three.js example loaders. BLEND files cannot be rendered in a
 * browser — the UI offers "open in Blender" instead (honest capability).
 *
 * Controls: orbit rotate / pan / zoom (OrbitControls), wireframe, material vs
 * solid mode, three-point lighting, bounding box, skeleton visualization,
 * animation playback, polygon/texture stats overlay.
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';

export interface ViewerStats {
  meshes: number;
  triangles: number;
  vertices: number;
  materials: number;
  textures: { name: string; size: string }[];
  hasSkeleton: boolean;
  animations: string[];
  bbox: { size: [number, number, number] };
}

export default function Viewer3D(props: { buffer: ArrayBuffer | null; fileName: string; height?: number; onStats?: (s: ViewerStats) => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    controls?: OrbitControls;
    root?: THREE.Object3D;
    mixer?: THREE.AnimationMixer;
    skeletonHelper?: THREE.SkeletonHelper;
    boxHelper?: THREE.Box3Helper;
    clock?: THREE.Clock;
    raf?: number;
    disposed?: boolean;
  }>({});
  const [wireframe, setWireframe] = useState(false);
  const [showBox, setShowBox] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- scene lifecycle
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const s = stateRef.current;
    s.disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, props.height ?? 420);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10131a);

    const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / (props.height ?? 420), 0.01, 2000);
    camera.position.set(3, 2, 4);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343d, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(5, 8, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.1);
    rim.position.set(-6, 3, -5);
    scene.add(rim);

    const grid = new THREE.GridHelper(10, 20, 0x2c3242, 0x1d2230);
    grid.position.y = -0.001;
    scene.add(grid);

    Object.assign(s, { renderer, scene, camera, controls, clock: new THREE.Clock() });

    const tick = () => {
      if (s.disposed) return;
      s.raf = requestAnimationFrame(tick);
      const dt = s.clock!.getDelta();
      s.mixer?.update(dt);
      s.controls?.update();
      s.renderer!.render(scene, camera);
    };
    tick();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      renderer.setSize(w, props.height ?? 420);
      camera.aspect = w / (props.height ?? 420);
      camera.updateProjectionMatrix();
    });
    ro.observe(mount);

    return () => {
      s.disposed = true;
      if (s.raf) cancelAnimationFrame(s.raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- model loading
  useEffect(() => {
    const s = stateRef.current;
    const { scene, camera, controls } = s;
    if (!scene || !props.buffer || !props.fileName) return;
    setError(null);
    if (s.root) { scene.remove(s.root); s.root = undefined; }
    if (s.skeletonHelper) { scene.remove(s.skeletonHelper); s.skeletonHelper = undefined; }
    if (s.boxHelper) { scene.remove(s.boxHelper); s.boxHelper = undefined; }
    s.mixer = undefined;

    const blob = new Blob([props.buffer]);
    const url = URL.createObjectURL(blob);
    const ext = props.fileName.toLowerCase().split('.').pop() ?? '';

    const finish = (root: THREE.Object3D, animations: THREE.AnimationClip[] = [], hasSkeleton = false) => {
      URL.revokeObjectURL(url);
      s.root = root;
      scene.add(root);

      // Normalize scale into view.
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 2.4 / maxDim;
      root.scale.setScalar(scale);
      root.position.sub(center.multiplyScalar(scale));
      root.position.y += size.y * scale / 2;

      if (hasSkeleton) {
        s.skeletonHelper = new THREE.SkeletonHelper(root);
        (s.skeletonHelper.material as THREE.LineBasicMaterial).linewidth = 2;
        s.skeletonHelper.visible = showSkeleton;
        scene.add(s.skeletonHelper);
      }
      s.boxHelper = new THREE.Box3Helper(new THREE.Box3().setFromObject(root), new THREE.Color(0x4f8cff));
      s.boxHelper.visible = showBox;
      scene.add(s.boxHelper);

      if (animations.length) {
        s.mixer = new THREE.AnimationMixer(root);
        s.mixer.clipAction(animations[0]).play();
      }
      camera?.position.set(3, 2.2, 4);
      controls?.target.set(0, 0.8, 0);

      // stats
      let triangles = 0, vertices = 0, meshes = 0;
      const materials = new Set<string>();
      const textures: { name: string; size: string }[] = [];
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        const geom = mesh.geometry;
        vertices += geom.attributes.position?.count ?? 0;
        triangles += geom.index ? geom.index.count / 3 : (geom.attributes.position?.count ?? 0) / 3;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          materials.add(m.uuid);
          for (const v of Object.values(m as unknown as Record<string, unknown>)) {
            const t = v as THREE.Texture;
            if (t?.isTexture && t.image && (t.image as { width?: number }).width) {
              const img = t.image as { width: number; height: number; src?: string };
              const name = img.src ? img.src.split('/').pop()?.slice(0, 40) ?? 'texture' : 'texture';
              textures.push({ name, size: `${img.width}×${img.height}` });
            }
          }
        }
      });
      const vs: ViewerStats = {
        meshes,
        triangles: Math.round(triangles),
        vertices,
        materials: materials.size,
        textures: textures.slice(0, 8),
        hasSkeleton,
        animations: animations.map((a) => a.name || 'clip'),
        bbox: { size: [size.x, size.y, size.z].map((v) => Math.round(v * 1000) / 1000) as [number, number, number] },
      };
      setStats(vs);
      props.onStats?.(vs);
      setShowSkeleton(hasSkeleton && showSkeleton);
    };

    try {
      if (ext === 'glb' || ext === 'gltf') {
        new GLTFLoader().load(url, (g) => finish(g.scene, g.animations, !!g.scenes?.[0] || g.scene.children.some(isSkinned)), undefined, (e: unknown) => setError(`glTF load failed: ${String(e)}`));
      } else if (ext === 'obj') {
        new OBJLoader().load(url, (o) => finish(o), undefined, (e: unknown) => setError(`OBJ load failed: ${String(e)}`));
      } else if (ext === 'stl') {
        const geom = new STLLoader().parse(props.buffer);
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xbfc7d6, flatShading: true }));
        finish(mesh);
      } else if (ext === 'ply') {
        const geom = new PLYLoader().parse(props.buffer);
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xbfc7d6 }));
        finish(mesh);
      } else if (ext === 'fbx') {
        new FBXLoader().load(url, (o) => finish(o, o.animations, o.children.some(isSkinned)), undefined, (e: unknown) => setError(`FBX load failed: ${String(e)}`));
      } else if (ext === 'dae') {
        new ColladaLoader().load(url, (c) => finish(c.scene, c.scene.animations ?? []), undefined, (e: unknown) => setError(`DAE load failed: ${String(e)}`));
      } else if (ext === 'blend') {
        setError('.blend files cannot be previewed in-app (binary Blender format). Use Converters → open in Blender.');
      } else {
        setError(`No in-app preview for .${ext} — try converting to GLB first.`);
      }
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.buffer, props.fileName]);

  // ---- toggles
  useEffect(() => {
    const s = stateRef.current;
    s.root?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const std = m as THREE.MeshStandardMaterial;
        if (wireframe) { std.wireframe = true; }
        else { std.wireframe = false; }
      }
    });
    if (s.boxHelper) s.boxHelper.visible = showBox;
    if (s.skeletonHelper) s.skeletonHelper.visible = showSkeleton;
  }, [wireframe, showBox, showSkeleton, stats]);

  useEffect(() => {
    const s = stateRef.current;
    if (s.mixer) s.mixer.timeScale = playing ? 1 : 0;
  }, [playing]);

  return (
    <div className="viewer-wrap" data-testid="viewer3d">
      <div className="viewer-toolbar">
        <button className={`btn small ${wireframe ? 'primary' : ''}`} onClick={() => setWireframe(!wireframe)}>Wireframe</button>
        <button className={`btn small ${showBox ? 'primary' : ''}`} onClick={() => setShowBox(!showBox)}>Bounding box</button>
        <span className="spacer" />
        {stats && stats.animations.length > 0 && (
          <button className={`btn small ${playing ? 'primary' : ''}`} onClick={() => setPlaying(!playing)}>
            {playing ? '⏸ Pause anim' : '▶ Play anim'}
          </button>
        )}
        {stats && stats.hasSkeleton && (
          <button className={`btn small ${showSkeleton ? 'primary' : ''}`} onClick={() => setShowSkeleton(!showSkeleton)}>Skeleton</button>
        )}
      </div>
      <div ref={mountRef} style={{ height: props.height ?? 420 }} />
      {stats && (
        <div className="viewer-stats">
          <div>Meshes: {stats.meshes} · Triangles: {stats.triangles.toLocaleString()} · Verts: {stats.vertices.toLocaleString()}</div>
          <div>Materials: {stats.materials}{stats.hasSkeleton ? ' · rigged' : ''}{stats.animations.length ? ` · anims: ${stats.animations.length}` : ''}</div>
          <div>BBox: {stats.bbox.size.join(' × ')}</div>
          {stats.textures.length > 0 && <div>Textures: {stats.textures.map((t) => `${t.name} (${t.size})`).slice(0, 4).join(', ')}</div>}
        </div>
      )}
      {error && <div className="empty" style={{ padding: 20 }}><div className="big">⚠️</div>{error}</div>}
      <div className="small muted" style={{ padding: '6px 10px' }}>
        Drag: rotate · Right-drag: pan · Wheel: zoom
      </div>
    </div>
  );
}

function isSkinned(o: THREE.Object3D): boolean {
  let found = false;
  o.traverse((c) => { if ((c as THREE.SkinnedMesh).isSkinnedMesh) found = true; });
  return found;
}
