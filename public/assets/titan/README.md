# Titan environment assets

The files in this directory are local, production-safe copies of assets from
[Poly Haven](https://polyhaven.com/). Poly Haven publishes its assets under
[CC0 1.0](https://polyhaven.com/license), including commercial use and
redistribution. Attribution is not required by the asset licence, but the
sources are recorded here for provenance and reproducible updates.

| Local directory | Source asset | Author | Runtime use |
| --- | --- | --- | --- |
| `environment/` | [Schachen Forest](https://polyhaven.com/a/schachen_forest) | Adrian Kubasa | 1K HDR image-based lighting |
| `forest_ground/` | [Forest Ground 01](https://polyhaven.com/a/forrest_ground_01) | Rob Tuytel | 1K diffuse, OpenGL normal and roughness maps |
| `grass_bermuda_01/` | [Grass Bermuda 01](https://polyhaven.com/a/grass_bermuda_01) | Poly Haven contributors | 1K glTF grass variants |
| `fern_02/` | [Fern 02](https://polyhaven.com/a/fern_02) | Poly Haven contributors | 1K glTF fern variants |
| `rock_face_01/` | [Rock Face 01](https://polyhaven.com/a/rock_face_01) | Poly Haven contributors | 1K glTF cliff face |
| `rock_moss_set_02/` | [Rock Moss Set 02](https://polyhaven.com/a/rock_moss_set_02) | Poly Haven contributors | 1K glTF boulder variants |
| `foliage/` | [Leaf Set 024](https://ambientcg.com/view?id=LeafSet024) | ambientCG | 1K colour, OpenGL normal, opacity and roughness maps |
| `bark/` | [Bark 012](https://ambientcg.com/view?id=Bark012) | ambientCG | 1K colour, OpenGL normal and roughness maps |

Poly Haven and ambientCG both publish these source assets under CC0 1.0. The
downloaded files are unmodified 1K distributions. Runtime code applies
instancing, scale variation, colour-neutral material tuning and distance
culling; it does not fetch from the live Poly Haven API.
