"""Low-poly rocky foreground and distant Rainier staging for create_scene.py.

All visible detail is ordinary mesh geometry and palette UVs. Related prop parts
share one mesh so the result stays inexpensive to draw in Three.js.
"""
import math
import random
from mathutils import Matrix, Vector
from mathutils.geometry import delaunay_2d_cdt


def ground_z(x, y):
    return .18 + .10 * math.sin(x * .47) * math.cos(y * .54) + .07 * math.cos(y * .8)


class Geometry:
    def __init__(self):
        self.vertices, self.faces, self.colors = [], [], []

    def add(self, vertices, faces, colors, transform=None):
        offset = len(self.vertices)
        self.vertices.extend([tuple(transform @ Vector(v)) for v in vertices] if transform else vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.colors.extend(colors)

    def emit(self, api, name, coll, root, material):
        return api['mesh'](name, self.vertices, self.faces, self.colors, coll, root, material)

    def box(self, center, size, colors=(17, 16, 17, 18, 17, 18), yaw=0, tilt=0):
        x, y, z = (s / 2 for s in size)
        vertices = [(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),
                    (-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]
        faces = [(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]
        transform = Matrix.Translation(Vector(center)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
        self.add(vertices, faces, list(colors), transform)

    def taper(self, center, radii, levels, colors, sides=7, transform=None):
        vertices, faces, swatches = [], [], []
        for radius, z in zip(radii, levels):
            for i in range(sides):
                a = i * math.tau / sides
                vertices.append((center[0] + radius * math.cos(a), center[1] + radius * math.sin(a), center[2] + z))
        for ring in range(len(radii) - 1):
            for i in range(sides):
                j = (i + 1) % sides
                faces.append((ring*sides+i,ring*sides+j,(ring+1)*sides+j,(ring+1)*sides+i))
                swatches.append(colors[i % len(colors)])
        faces.extend((tuple(reversed(range(sides))),tuple((len(radii)-1)*sides+i for i in range(sides))))
        swatches.extend((colors[0], colors[-1]))
        self.add(vertices, faces, swatches, transform)

    def beam(self, start, end, radius, colors=(16,17,18), sides=6):
        direction = Vector(end) - Vector(start)
        transform = Matrix.Translation(Vector(start)) @ direction.to_track_quat('Z','Y').to_matrix().to_4x4()
        self.taper((0,0,0),(radius,radius*.87),(0,direction.length),colors,sides,transform)

    def rock(self, center, scale, seed, colors=(19,20,21,20,3), sides=7):
        rng = random.Random(seed)
        vertices, faces, swatches = [], [], []
        irregular = [rng.uniform(.83,1.16) for _ in range(sides)]
        yaw = rng.random() * math.tau
        for ring, (radius,z) in enumerate(((.79,-.12),(1,.30),(.65,.83))):
            for i in range(sides):
                angle = i * math.tau / sides + yaw
                r = radius * irregular[i]
                vertices.append((center[0] + scale[0]*(r*math.cos(angle)+.08*ring),
                                 center[1] + scale[1]*r*math.sin(angle),
                                 center[2] + scale[2]*(z+rng.uniform(-.09,.09))))
        vertices.append((center[0]+scale[0]*.12,center[1],center[2]+scale[2]*.94))
        for ring in range(2):
            for i in range(sides):
                j=(i+1)%sides
                if (i+ring) % 3 == 0:
                    faces.extend(((ring*sides+i,ring*sides+j,(ring+1)*sides+j),
                                  (ring*sides+i,(ring+1)*sides+j,(ring+1)*sides+i)))
                    swatches.extend(rng.choices(colors,k=2))
                else:
                    faces.append((ring*sides+i,ring*sides+j,(ring+1)*sides+j,(ring+1)*sides+i))
                    swatches.append(rng.choice(colors))
        for i in range(sides):
            faces.append((2*sides+i,2*sides+(i+1)%sides,len(vertices)-1))
            swatches.append(rng.choice(colors[1:]))
        faces.append(tuple(reversed(range(sides))))
        swatches.append(colors[0])
        self.add(vertices,faces,swatches)


def terrain(api, coll, root, material):
    rng=random.Random(7924)
    n=36
    boundary=[rng.uniform(.91,1.08) for _ in range(n)]
    rim=[]
    for i in range(n):
        a=i*math.tau/n
        x,y=11.4*boundary[i]*math.cos(a),7.8*boundary[i]*math.sin(a)
        rim.append((x,y,ground_z(x,y)))
    coords=[Vector((x,y)) for x,y,z in rim]
    for row in range(6):
        for col in range(10):
            x=-9+col*2+(row%2)*.4+rng.uniform(-.45,.45)
            y=-5+row*2+rng.uniform(-.4,.4)
            if (x/10.7)**2+(y/7.1)**2 < .9:
                coords.append(Vector((x,y)))
    # Irregular local triangles avoid a radial star pattern across the floor.
    points,_,faces,*_=delaunay_2d_cdt(coords,[],[list(range(n))],1,1e-5)
    vertices=[(v.x,v.y,ground_z(v.x,v.y)) for v in points]
    colors=rng.choices((20,20,20,21,21,19,3),k=len(faces))
    api['mesh']('Platform - fractured slate surface',vertices,faces,colors,coll,root,material)
    vertices=list(rim)
    for ring,(radius,z) in enumerate(((1.035,-.65),(.91,-2.35),(.60,-4.6))):
        for i in range(n):
            a=i*math.tau/n
            r=radius*boundary[i]*rng.uniform(.95,1.05)
            vertices.append((11.4*r*math.cos(a)+ring*.30,7.8*r*math.sin(a),z+rng.uniform(-.38,.38)))
    vertices.append((1,-.8,-6.3))
    faces,colors=[],[]
    for ring in range(3):
        for i in range(n):
            j=(i+1)%n;a,b=ring*n,(ring+1)*n
            faces.extend(((a+i,b+i,b+j),(a+i,b+j,a+j)))
            colors.extend(rng.choices((19,20,3,4) if ring==0 else (0,1,2,19,20),k=2))
    for i in range(n):
        faces.append((3*n+i,4*n,3*n+(i+1)%n));colors.append(rng.choice((0,1,19)))
    api['mesh']('Platform - broken cliff strata',vertices,faces,colors,coll,root,material)
    # Shallow angular plates make the floor read as stone without blocking its center.
    plates=Geometry()
    for i,(x,y,sx,sy) in enumerate(((-3,-3.8,2,1.3),(-.2,-4.4,1.6,1.0),(2.6,-3.5,1.7,1.1),
                                   (-3.2,-.6,1.6,1.2),(-.3,-.8,2.1,1.5),(3.1,-.4,1.3,1.4),
                                   (-1.8,2,1.8,1.2),(1.7,2.1,1.6,1.0))):
        plates.rock((x,y,ground_z(x,y)-.08),(sx,sy,.20),500+i,(19,20,21,20),6)
    plates.emit(api,'Floor - overlapping cracked flagstones',coll,root,material)
    cracks=Geometry()
    for points in (((-5,-4),(-3.9,-3),(-3.1,-3.2),(-1.7,-2)),((.7,-5.6),(1.3,-4.6),(1,-3.7)),
                   ((-2,3.8),(-1.4,2.9),(-.3,2.7)),((3,-1.7),(4.3,-1.3),(4.9,-2))):
        for a,b in zip(points,points[1:]):
            dx,dy=b[0]-a[0],b[1]-a[1];l=math.hypot(dx,dy);w=.035
            dx,dy=-dy/l*w,dx/l*w
            vertices=[(p[0]+sx*dx,p[1]+sx*dy,ground_z(*p)+.12) for p,sx in ((a,-1),(b,-1),(b,1),(a,1))]
            cracks.add(vertices,[(0,1,2,3)],[0])
    cracks.emit(api,'Floor - deep fissures',coll,root,material)


def outcrops(api,coll,root,material):
    groups=[('left rim',[(-9,0,2,1.6,1.8),(-9.4,-2.4,1.4,1.4,1.2),(-8,-4.8,1.6,1.1,.9),(-10,2.3,1.2,1.5,1.4)]),
            ('right rim',[(8.6,-.5,2.0,1.7,2.2),(9.5,2.1,1.25,1.5,1.6),(8.1,-3.2,1.6,1.2,1.0),(7,-5.3,1.25,.8,.6)]),
            ('back ridge',[(-7,4.8,2,1.3,1.4),(-3.5,6.6,1.9,1.0,1.0),(0,6.5,1.6,1.4,.9),(3.5,5.8,1.5,1.3,.8)]),
            ('front ledge',[(-5.4,-6.6,1.3,.8,.7),(-1.5,-7.3,1.0,.65,.4),(3.2,-6.8,1.45,.8,.75)])]
    for g,(name,rocks) in enumerate(groups):
        geo=Geometry()
        for i,(x,y,sx,sy,sz) in enumerate(rocks):
            geo.rock((x,y,ground_z(x,y)-.15),(sx,sy,sz),1100+g*100+i)
        geo.emit(api,'Outcrop - '+name,coll,root,material)
    rng=random.Random(837)
    rubble=Geometry()
    for i in range(55):
        a=rng.uniform(0,math.tau);r=rng.uniform(.66,.95)
        x,y=10.7*r*math.cos(a),7.1*r*math.sin(a)
        s=rng.uniform(.10,.38)
        rubble.rock((x,y,ground_z(x,y)-.02),(s,s*rng.uniform(.6,1.2),s*.65),2000+i,sides=5)
    rubble.emit(api,'Rubble - loose scree and pebbles',coll,root,material)
    drift=Geometry()
    for i,(x,y,z,s) in enumerate(((-9,-4,-3.8,.7),(9.6,0,-3.3,.55),(5,-6,-5.5,.45),(-5,-5.7,-6,.32))):
        drift.rock((x,y,z),(s,s*.9,s*1.5),300+i,(0,1,19,20),6)
    drift.emit(api,'Floating fragments below the ledge',coll,root,material)


def ruined_arch(api,coll,root,material):
    geo=Geometry();x,y=-5.1,3.4;z=ground_z(x,y)
    for side in (-1,1):
        for course in range(4):
            geo.box((x+side*1.4,y,z+.25+course*.48),(.69,.9,.44),
                    (19,20,21,3,20,21),yaw=side*.025*(course%2))
        geo.box((x+side*1.4,y,z+.12),(1.05,1.15,.25),(19,20,21,20,3,21))
    for i in range(9):
        a,b=i*math.pi/9+.012,(i+1)*math.pi/9-.012
        vertices=[]
        for depth in (-.45,.45):
            for radius,angle in ((1.08,a),(1.77,a),(1.77,b),(1.08,b)):
                vertices.append((x+radius*math.cos(angle),y+depth,z+1.9+radius*math.sin(angle)))
        geo.add(vertices,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],
                [20,19,3,21,20,19])
    for i,(dx,dy) in enumerate(((-2.1,-.8),(.6,-1.4),(2.2,.1))):
        geo.box((x+dx,y+dy,ground_z(x+dx,y+dy)+.13),(.7,.6,.35),(19,20,3,21,20,21),yaw=i*.6,tilt=.16)
    geo.emit(api,'Ruin - weathered stone arch and fallen blocks',coll,root,material)
    geo=Geometry();x,y=-6,-2.6;z=ground_z(x,y)
    geo.box((x,y,z+.12),(1.5,1.4,.28),(19,20,21,20,3,21),yaw=.12)
    geo.taper((x,y,z+.2),(.51,.49,.44),(0,.6,1.15),(19,20,21,3),8)
    geo.taper((x,y,z+1.34),(.59,.6),(0,.18),(19,21,20),8)
    geo.beam((-5.3,-3.4,z+.4),(-3.9,-3.0,z+.48),.40,(19,20,21),8)
    geo.emit(api,'Ruin - snapped column and fallen shaft',coll,root,material)


def crate(api,name,x,y,size,yaw,coll,root,material):
    geo=Geometry();z=ground_z(x,y)+size*.5
    # Assemble in local space, then rotate the complete crate.
    local=Geometry();s=size
    local.box((0,0,0),(s,s,s),(16,17,18,17,16,18))
    for d in (-.38,.38):
        local.box((d*s,0,0),(.11*s,1.035*s,1.05*s),(16,18,17,18,17,18))
    for d in (-.44,.44):
        local.box((0,-.515*s,d*s),(s,.07*s,.10*s),(16,17,18,17,16,18))
        local.box((0,.515*s,d*s),(s,.07*s,.10*s),(16,17,18,17,16,18))
    for k in (-.21,0,.21):
        local.box((k*s,-.506*s,0),(.012*s,.018*s,.80*s),(16,)*6)
    # Diagonal front brace gives the box a clear silhouette/read at game distance.
    local.box((0,-.555*s,0),(.12*s,.07*s,1.08*s),(16,18,17,18,17,18),tilt=.7)
    transform=Matrix.Translation(Vector((x,y,z)))@Matrix.Rotation(yaw,4,'Z')
    geo.add(local.vertices,local.faces,local.colors,transform)
    geo.emit(api,name,coll,root,material)


def props(api,coll,root,material):
    ruined_arch(api,coll,root,material)
    crate(api,'Supplies - large braced crate',5.4,2.5,1.15,.16,coll,root,material)
    crate(api,'Supplies - small crooked crate',6.4,1.9,.78,-.23,coll,root,material)
    for i,(x,y) in enumerate(((6.9,.1),(5.8,-.45))):
        geo=Geometry();z=ground_z(x,y)
        geo.taper((x,y,z),(.38,.46,.46,.37),(0,.22,.88,1.1),(16,17,18,17,16,17,18,17),10)
        for h in (.18,.86):
            geo.taper((x,y,z),(.465,.465),(h,h+.10),(19,20,19,19),10)
        for dx in (-.17,0,.17):
            geo.box((x+dx,y,z+1.107),(.013,.60,.01),(16,)*6)
        geo.emit(api,f'Supplies - iron-banded barrel {i+1}',coll,root,material)
    geo=Geometry();x,y=-3.9,.1;z=ground_z(x,y)
    geo.taper((x,y,z+.02),(.65,.65),(0,.04),(0,),10)
    for i in range(9):
        a=i*math.tau/9
        geo.rock((x+.80*math.cos(a),y+.80*math.sin(a),z),(.23,.20,.22),400+i,(19,20,21),5)
    geo.beam((x-.52,y-.25,z+.14),(x+.5,y+.25,z+.18),.12,(0,16,17))
    geo.beam((x-.3,y+.5,z+.24),(x+.3,y-.5,z+.27),.11,(0,16,17))
    for i in range(5):
        a=i*math.tau/5
        geo.rock((x+.22*math.cos(a),y+.2*math.sin(a),z+.07),(.07,.07,.08),510+i,(2,28,0),5)
    geo.emit(api,'Camp - stone fire ring and charred logs',coll,root,material)
    geo=Geometry();x,y=2.9,4.5;z=ground_z(x,y)
    geo.beam((x,y,z),(x+.12,y,z+1.9),.095,(16,17,18),5)
    geo.box((x+.10,y,z+1.55),(1.1,.16,.35),(16,17,18,17,16,18),yaw=.08,tilt=-.08)
    geo.box((x+.18,y,z+1.12),(.72,.17,.23),(16,18,17,17,16,18),yaw=-.06,tilt=.09)
    geo.emit(api,'Trail prop - weathered signpost',coll,root,material)
    geo=Geometry()
    posts=[(4.2,4.3),(5.7,4.0),(7.1,3.6)]
    for x,y in posts:
        z=ground_z(x,y)
        geo.beam((x,y,z-.06),(x-.05,y+.02,z+1.25),.095,(16,17,18),5)
    for a,b in zip(posts,posts[1:]):
        for h in (.55,1.02):
            geo.beam((a[0],a[1],ground_z(*a)+h),(b[0],b[1],ground_z(*b)+h),.065,(16,17),5)
    geo.emit(api,'Lookout - broken timber railing',coll,root,material)


def vegetation(api,coll,root,material):
    for index,(x,y,s) in enumerate(((-8.1,2.8,.72),(-7.6,5,.53),(8.2,3.9,.68),(1.6,6.1,.54))):
        geo=Geometry();z=ground_z(x,y)
        geo.taper((x,y,z),(.12*s,.075*s),(0,3*s),(16,17),5)
        for tier,(h,r) in enumerate(((.8,1.0),(1.55,.75),(2.2,.48))):
            geo.taper((x+.1*tier*s,y,z),(.94*r*s,.8*r*s,.025*s),
                      (h*s,(h+.17)*s,(h+1.5)*s),(12,13,14,13,15,13,14),7)
        geo.emit(api,f'Pine - windworn rim tree {index+1}',coll,root,material)
    geo=Geometry();x,y=-8.2,-.5;z=ground_z(x,y)
    geo.beam((x,y,z),(x+.23,y+.05,z+2.45),.13,(16,17,18),5)
    for a,b in (((x+.14,y,z+1.2),(x-.65,y+.1,z+1.85)),
                ((x+.20,y,z+1.75),(x+.8,y+.22,z+2.05)),
                ((x+.2,y,z+2),(x-.2,y-.2,z+2.35))):
        geo.beam(a,b,.065,(16,17,18),5)
    geo.beam((-7.3,-4.0,ground_z(-7.3,-4)+.13),(-5.7,-4.5,ground_z(-5.7,-4.5)+.2),.16,(16,17,18),6)
    geo.emit(api,'Deadwood - bare snag and fallen limb',coll,root,material)
    geo=Geometry();rng=random.Random(971)
    for x,y in ((-8.4,-3),(7.8,-2),(-6,1.5),(4.2,5.4),(-2,5.6),(5,-4.7),(8.8,2.1),(-7.1,-5.1)):
        z=ground_z(x,y)
        for i in range(3):
            a=rng.random()*math.tau;dx,dy=.09*math.cos(a),.09*math.sin(a)
            geo.add([(x-dx,y-dy,z),(x+dx,y+dy,z),(x+.4*dx,y+.4*dy,z+rng.uniform(.16,.31))],[(0,1,2)],[rng.choice((8,9,31))])
    geo.emit(api,'Crevices - sparse dry grass',coll,root,material)


def build(api,scene,material):
    collection,empty=api['collection'],api['empty']
    asset=collection('EXPORT - Floating Island',scene.collection)
    ground=collection('01 - Rocky platform',asset)
    rocks=collection('02 - Outcrops and rubble',asset)
    prop_collection=collection('03 - Ruins and supplies',asset)
    nature=collection('04 - Sparse vegetation',asset)
    root=empty('FloatingIsland',asset)
    root['asset']='rocky_floating_platform'
    root['export_collection']=asset.name
    terrain(api,ground,root,material)
    outcrops(api,rocks,root,material)
    props(api,prop_collection,root,material)
    vegetation(api,nature,root,material)
    # Independent top-level root, physically separated by >15 units of air.
    background=collection('EXPORT - Rainier Background',scene.collection)
    mountain=empty('MountRainierBackdrop',background)
    obj=api['make_rainier'](background,mountain,material)
    mountain.location=(-8,32,-6.8)
    mountain.scale=(1.4,.65,1.05)
    mountain['role']='Distant scenery; independent of the foreground platform'
    # Remap dark rock to cooler light swatches: baked atmospheric perspective.
    uv=obj.data.uv_layers.active.data
    for poly in obj.data.polygons:
        loop=poly.loop_indices[0]
        old=uv[loop].uv.copy()
        col,row=int(old.x*8),int(old.y*4)
        original=row*8+col
        target={19:22,20:23,21:23,22:22,23:23,24:25,25:26,26:26,27:27}.get(original,original)
        dx,dy=(target%8-col)/8,(target//8-row)/4
        for loop in poly.loop_indices:
            uv[loop].uv.x+=dx;uv[loop].uv.y+=dy
    scene['background_export_collection']=background.name
    scene['background_export_filename']='rainier_backdrop.glb'
    return asset,root
