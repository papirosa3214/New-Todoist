import json

ws_path = '/Users/max/Projects/TaskFlow/ios/DerivedData/00008150-001545400144401C/SourcePackages/workspace-state.json'
with open(ws_path) as f:
    d = json.load(f)

mlx_swift_entry = {
    "basedOn": None,
    "packageRef": {
        "identity": "mlx-swift",
        "kind": "remoteSourceControl",
        "location": "https://github.com/ml-explore/mlx-swift.git",
        "name": "mlx-swift"
    },
    "state": {
        "checkoutState": {
            "revision": "96c0f69cf15f38abd6248bb71fca908171dab1d8",
            "version": "0.25.6"
        },
        "name": "sourceControlCheckout"
    },
    "subpath": "mlx-swift"
}

names = [dep.get('packageRef', {}).get('name') for dep in d['object']['dependencies']]
if 'mlx-swift' not in names:
    d['object']['dependencies'].append(mlx_swift_entry)
    with open(ws_path, 'w') as f:
        json.dump(d, f, indent=2)
    print("Added mlx-swift to workspace-state.json")
else:
    print("mlx-swift already exists")
