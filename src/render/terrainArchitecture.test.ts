import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { CRATER_RIDGE } from '../game/map';
import type { AabbObstacle } from '../game/types';
import {
  artificialSurfaceColor,
  classifyObstacleVisual,
  createChamferedCargoGeometry,
  createIndustrialPlanterVisual,
  createOrganicObstacleGeometry,
} from './terrainArchitecture';

const obstacle = (id: string, kind: AabbObstacle['kind'] = 'cover'): AabbObstacle => ({
  id,
  kind,
  color: 0xffffff,
  min: { x: -3, y: 0, z: -2 },
  max: { x: 3, y: 1.4, z: 2 },
});

describe('terrain and architecture visual vocabulary', () => {
  it('never mistakes a manufactured planter for natural terrain', () => {
    expect(classifyObstacleVisual(obstacle('south-planter-west', 'platform'))).toBe('planter');
    expect(classifyObstacleVisual(obstacle('south-planter-west-step', 'platform'))).toBe('planter');
    expect(classifyObstacleVisual(obstacle('south-planter-west-cover'))).toBe('planter');
    expect(classifyObstacleVisual(obstacle('north-ridge-west', 'platform'))).toBe('earth');
    expect(classifyObstacleVisual(obstacle('north-earth-knoll-outcrop-west'))).toBe('rock');
    expect(classifyObstacleVisual(obstacle('south-greenhouse-growbed-west'))).toBe('authored');
  });

  it('creates a closed organic silhouette with substantially more shape information than a cube', () => {
    const earth = createOrganicObstacleGeometry(new THREE.Vector3(8, 1.2, 5), 441, false);
    const rock = createOrganicObstacleGeometry(new THREE.Vector3(3.5, 2.4, 2.8), 917, true);
    const earthPosition = earth.getAttribute('position');
    const rockPosition = rock.getAttribute('position');

    expect(earthPosition.count).toBeGreaterThan(60);
    expect(rockPosition.count).toBeGreaterThan(120);
    expect(earth.index?.count).toBeGreaterThan(200);
    expect(rock.index).toBeNull();
    expect(earth.boundingBox?.max.x).toBeGreaterThan(3.8);
    expect(earth.boundingBox?.min.x).toBeLessThan(-3.8);
    expect(rock.boundingBox?.max.y).toBeGreaterThan(1.15);

    earth.dispose();
    rock.dispose();
  });

  it('provides a clipped-corner cargo primitive with full collision extents', () => {
    const size = new THREE.Vector3(4, 2.7, 3.8);
    const geometry = createChamferedCargoGeometry(size);
    const position = geometry.getAttribute('position');
    const uniqueFrontProfile = new Set<string>();
    for (let index = 0; index < position.count; index += 1) {
      if (Math.abs(position.getZ(index) - size.z * 0.5) > 0.001) continue;
      uniqueFrontProfile.add(`${position.getX(index).toFixed(3)}:${position.getY(index).toFixed(3)}`);
    }

    expect(uniqueFrontProfile.size).toBeGreaterThanOrEqual(8);
    expect(geometry.boundingBox?.min.x).toBeCloseTo(-2);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(2);
    expect(geometry.boundingBox?.min.z).toBeCloseTo(-1.9);
    expect(geometry.boundingBox?.max.z).toBeCloseTo(1.9);
    geometry.dispose();
  });

  it('confines natural material to the horizontal bed of an industrial planter', () => {
    const shell = new THREE.MeshStandardMaterial({ name: 'industrial-shell' });
    const frame = new THREE.MeshStandardMaterial({ name: 'industrial-frame' });
    const soil = new THREE.MeshStandardMaterial({ name: 'contained-soil' });
    const foliage = new THREE.MeshStandardMaterial({ name: 'ordered-crops' });
    const accent = new THREE.MeshBasicMaterial({ name: 'status-accent' });
    const visual = createIndustrialPlanterVisual(obstacle('south-planter-east', 'platform'), {
      shell,
      frame,
      soil,
      foliage,
      accent,
    });
    const manufacturedShell = visual.getObjectByName('south-planter-east-manufactured-shell') as THREE.Mesh;
    const containedSoil = visual.getObjectByName('south-planter-east-contained-soil') as THREE.Mesh;

    expect(manufacturedShell.material).toBe(shell);
    expect(containedSoil.material).toBe(soil);
    expect(containedSoil.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(visual.getObjectByName('south-planter-east-ordered-crop-rows')).toBeInstanceOf(THREE.InstancedMesh);
    expect(visual.userData.naturalMaterialConfinedToTop).toBe(true);

    visual.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    shell.dispose();
    frame.dispose();
    soil.dispose();
    foliage.dispose();
    accent.dispose();
  });

  it('uses several coherent industrial coatings across facility zones', () => {
    const colors = new Set(
      CRATER_RIDGE.obstacles
        .filter((candidate) => classifyObstacleVisual(candidate) === 'facility')
        .map((candidate) => artificialSurfaceColor(candidate)),
    );

    expect(colors.size).toBeGreaterThanOrEqual(8);
    expect(artificialSurfaceColor(obstacle('west-mid-console-n')))
      .toBe(artificialSurfaceColor(obstacle('east-mid-console-n')));
    for (const buildingId of ['west-base-front-n', 'north-relay-front-west', 'south-greenhouse-front-east']) {
      const finish = new THREE.Color(artificialSurfaceColor(obstacle(buildingId)));
      expect(finish.getHSL({ h: 0, s: 0, l: 0 }).l, buildingId).toBeGreaterThan(0.58);
    }
  });
});
