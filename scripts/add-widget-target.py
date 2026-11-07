import re
import uuid

def generate_id():
    return uuid.uuid4().hex[:24].upper()

pbx_path = "ios/App/App.xcodeproj/project.pbxproj"
with open(pbx_path, "r", encoding="utf-8") as f:
    content = f.read()

# Let's check if TaskFlowWidgets is already added
if "TaskFlowWidgets.appex" in content:
    print("Already added!")
    exit(0)

# IDs
ID_WIDGET_APPEX = generate_id()
ID_WIDGET_BUNDLE_SRC = generate_id()
ID_WIDGET_BUNDLE_FILE = generate_id()
ID_WIDGET_VIEW_SRC = generate_id()
ID_WIDGET_VIEW_FILE = generate_id()
ID_WIDGET_ATTR_SRC = generate_id()
ID_WIDGET_INFOPLIST = generate_id()

ID_WIDGET_SOURCES_PHASE = generate_id()
ID_WIDGET_FRAMEWORKS_PHASE = generate_id()
ID_WIDGET_RESOURCES_PHASE = generate_id()
ID_WIDGET_TARGET = generate_id()
ID_WIDGET_CONFIG_LIST = generate_id()
ID_WIDGET_DEBUG_CONFIG = generate_id()
ID_WIDGET_RELEASE_CONFIG = generate_id()
ID_WIDGET_GROUP = generate_id()

ID_EMBED_PHASE = generate_id()
ID_EMBED_APPEX_BUILD_FILE = generate_id()
ID_TARGET_DEPENDENCY = generate_id()
ID_CONTAINER_PROXY = generate_id()

# 1. Add Build Files
build_files_block = f"""\
\t\t{ID_WIDGET_BUNDLE_SRC} /* TaskFlowWidgetBundle.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {ID_WIDGET_BUNDLE_FILE} /* TaskFlowWidgetBundle.swift */; }};
\t\t{ID_WIDGET_VIEW_SRC} /* TaskActivityWidget.swift in Sources */ = {{isa = PBXBuildFile; fileRef = {ID_WIDGET_VIEW_FILE} /* TaskActivityWidget.swift */; }};
\t\t{ID_WIDGET_ATTR_SRC} /* TaskActivityAttributes.swift in Sources */ = {{isa = PBXBuildFile; fileRef = 7A1C4E20B3D94F1180AA0502 /* TaskActivityAttributes.swift */; }};
\t\t{ID_EMBED_APPEX_BUILD_FILE} /* TaskFlowWidgets.appex in Embed App Extensions */ = {{isa = PBXBuildFile; fileRef = {ID_WIDGET_APPEX} /* TaskFlowWidgets.appex */; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy, ); }}; }};
"""
content = re.sub(r"(/\* Begin PBXBuildFile section \*/\n)", r"\1" + build_files_block, content)

# 2. Add Container Proxy & Target Dependency
proxy_block = f"""\
/* Begin PBXContainerItemProxy section */
\t\t{ID_CONTAINER_PROXY} /* PBXContainerItemProxy */ = {{
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = 504EC2FC1FED79650016851F /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = {ID_WIDGET_TARGET};
\t\t\tremoteInfo = TaskFlowWidgets;
\t\t}};
/* End PBXContainerItemProxy section */

/* Begin PBXCopyFilesBuildPhase section */
\t\t{ID_EMBED_PHASE} /* Embed App Extensions */ = {{
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t{ID_EMBED_APPEX_BUILD_FILE} /* TaskFlowWidgets.appex in Embed App Extensions */,
\t\t\t);
\t\t\tname = "Embed App Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};
/* End PBXCopyFilesBuildPhase section */
"""
content = re.sub(r"(/\* End PBXBuildFile section \*/\n)", r"\1" + proxy_block, content)

# 3. Add File References
file_refs_block = f"""\
\t\t{ID_WIDGET_APPEX} /* TaskFlowWidgets.appex */ = {{isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = TaskFlowWidgets.appex; sourceTree = BUILT_PRODUCTS_DIR; }};
\t\t{ID_WIDGET_BUNDLE_FILE} /* TaskFlowWidgetBundle.swift */ = {{isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = sourcecode.swift; path = TaskFlowWidgetBundle.swift; sourceTree = "<group>"; }};
\t\t{ID_WIDGET_VIEW_FILE} /* TaskActivityWidget.swift */ = {{isa = PBXFileReference; includeInIndex = 1; lastKnownFileType = sourcecode.swift; path = TaskActivityWidget.swift; sourceTree = "<group>"; }};
\t\t{ID_WIDGET_INFOPLIST} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; }};
"""
content = re.sub(r"(/\* Begin PBXFileReference section \*/\n)", r"\1" + file_refs_block, content)

# 4. Add Group for TaskFlowWidgets and update Products & Main group
products_entry = f"\t\t\t\t{ID_WIDGET_APPEX} /* TaskFlowWidgets.appex */,\n"
content = re.sub(r"(504EC3051FED79650016851F /\* Products \*/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n\t\t\t\t504EC3041FED79650016851F /\* App.app \*/,\n)", r"\1" + products_entry, content)

widget_group_block = f"""\
\t\t{ID_WIDGET_GROUP} /* TaskFlowWidgets */ = {{
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t{ID_WIDGET_BUNDLE_FILE} /* TaskFlowWidgetBundle.swift */,
\t\t\t\t{ID_WIDGET_VIEW_FILE} /* TaskActivityWidget.swift */,
\t\t\t\t7A1C4E20B3D94F1180AA0502 /* TaskActivityAttributes.swift */,
\t\t\t\t{ID_WIDGET_INFOPLIST} /* Info.plist */,
\t\t\t);
\t\t\tpath = TaskFlowWidgets;
\t\t\tsourceTree = "<group>";
\t\t}};
"""
content = re.sub(r"(504EC2FB1FED79650016851F = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)", r"\1\t\t\t\t" + f"{ID_WIDGET_GROUP} /* TaskFlowWidgets */,\n", content)
content = re.sub(r"(/\* End PBXGroup section \*/)", widget_group_block + r"\1", content)

# 5. Add Native Target for TaskFlowWidgets
widget_native_target = f"""\
\t\t{ID_WIDGET_TARGET} /* TaskFlowWidgets */ = {{
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = {ID_WIDGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "TaskFlowWidgets" */;
\t\t\tbuildPhases = (
\t\t\t\t{ID_WIDGET_SOURCES_PHASE} /* Sources */,
\t\t\t\t{ID_WIDGET_FRAMEWORKS_PHASE} /* Frameworks */,
\t\t\t\t{ID_WIDGET_RESOURCES_PHASE} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = TaskFlowWidgets;
\t\t\tproductName = TaskFlowWidgets;
\t\t\tproductReference = {ID_WIDGET_APPEX} /* TaskFlowWidgets.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t}};
"""
content = re.sub(r"(/\* Begin PBXNativeTarget section \*/\n)", r"\1" + widget_native_target, content)

# 6. Add Target Dependency & Embed Phase to App Target
content = re.sub(
    r"(504EC3031FED79650016851F /\* App \*/ = \{\n\t\t\tisa = PBXNativeTarget;[^\}]+buildPhases = \(\n)",
    r"\1\t\t\t\t" + f"{ID_EMBED_PHASE} /* Embed App Extensions */,\n",
    content
)
target_dep_block = f"""\
/* Begin PBXTargetDependency section */
\t\t{ID_TARGET_DEPENDENCY} /* PBXTargetDependency */ = {{
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = {ID_WIDGET_TARGET} /* TaskFlowWidgets */;
\t\t\ttargetProxy = {ID_CONTAINER_PROXY} /* PBXContainerItemProxy */;
\t\t}};
/* End PBXTargetDependency section */
"""
content = re.sub(
    r"(504EC3031FED79650016851F /\* App \*/ = \{\n\t\t\tisa = PBXNativeTarget;[^\}]+dependencies = \(\n)",
    r"\1\t\t\t\t" + f"{ID_TARGET_DEPENDENCY} /* PBXTargetDependency */,\n",
    content
)
content = re.sub(r"(/\* End PBXNativeTarget section \*/\n)", r"\1" + target_dep_block, content)

# 7. Add Target to Project Targets List
content = re.sub(
    r"(targets = \(\n\t\t\t\t504EC3031FED79650016851F /\* App \*/,\n)",
    r"\1\t\t\t\t" + f"{ID_WIDGET_TARGET} /* TaskFlowWidgets */,\n",
    content
)

# 8. Add Target Attributes for TaskFlowWidgets (DevelopmentTeam, etc)
target_attr_entry = f"""\
\t\t\t\t\t{ID_WIDGET_TARGET} = {{
\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;
\t\t\t\t\t\tDevelopmentTeam = 83Y92HGXXS;
\t\t\t\t\t\tProvisioningStyle = Automatic;
\t\t\t\t\t}};
"""
content = re.sub(r"(TargetAttributes = \{\n)", r"\1" + target_attr_entry, content)

# 9. Add Sources / Frameworks / Resources phases for Widget Target
widget_phases = f"""\
\t\t{ID_WIDGET_SOURCES_PHASE} /* Sources */ = {{
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t{ID_WIDGET_BUNDLE_SRC} /* TaskFlowWidgetBundle.swift in Sources */,
\t\t\t\t{ID_WIDGET_VIEW_SRC} /* TaskActivityWidget.swift in Sources */,
\t\t\t\t{ID_WIDGET_ATTR_SRC} /* TaskActivityAttributes.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};
\t\t{ID_WIDGET_FRAMEWORKS_PHASE} /* Frameworks */ = {{
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};
\t\t{ID_WIDGET_RESOURCES_PHASE} /* Resources */ = {{
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t}};
"""
content = re.sub(r"(/\* Begin PBXSourcesBuildPhase section \*/\n)", r"\1" + widget_phases, content)

# 10. Add Build Configurations for TaskFlowWidgets
widget_configs = f"""\
\t\t{ID_WIDGET_DEBUG_CONFIG} /* Debug */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tCLANG_ANALYZER_NUMBER_OBJECT_CONVERSION = YES_AGGRESSIVE;
\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "gnu++14";
\t\t\t\tCLANG_ENABLE_OBJC_WEAK = YES;
\t\t\t\tCLANG_WARN_DOCUMENTATION_COMMENTS = YES;
\t\t\t\tCLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;
\t\t\t\tCLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = 83Y92HGXXS;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = TaskFlowWidgets/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "TaskFlow Widgets";
\t\t\t\tINFOPLIST_KEY_NSHumanReadableCopyright = "";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.1;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t\t"@executable_path/../../Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tMTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;
\t\t\t\tMTL_FAST_MATH = YES;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.maksim.taskflow.TaskFlowWidgets;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-Onone";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t}};
\t\t\tname = Debug;
\t\t}};
\t\t{ID_WIDGET_RELEASE_CONFIG} /* Release */ = {{
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {{
\t\t\t\tCLANG_ANALYZER_NUMBER_OBJECT_CONVERSION = YES_AGGRESSIVE;
\t\t\t\tCLANG_CXX_LANGUAGE_STANDARD = "gnu++14";
\t\t\t\tCLANG_ENABLE_OBJC_WEAK = YES;
\t\t\t\tCLANG_WARN_DOCUMENTATION_COMMENTS = YES;
\t\t\t\tCLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES;
\t\t\t\tCLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tDEVELOPMENT_TEAM = 83Y92HGXXS;
\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;
\t\t\t\tGENERATE_INFOPLIST_FILE = NO;
\t\t\t\tINFOPLIST_FILE = TaskFlowWidgets/Info.plist;
\t\t\t\tINFOPLIST_KEY_CFBundleDisplayName = "TaskFlow Widgets";
\t\t\t\tINFOPLIST_KEY_NSHumanReadableCopyright = "";
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.1;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t\t"@executable_path/../../Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tMTL_FAST_MATH = YES;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.maksim.taskflow.TaskFlowWidgets;
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_COMPILATION_MODE = "wholemodule";
\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t}};
\t\t\tname = Release;
\t\t}};
"""
content = re.sub(r"(/\* Begin XCBuildConfiguration section \*/\n)", r"\1" + widget_configs, content)

widget_config_list = f"""\
\t\t{ID_WIDGET_CONFIG_LIST} /* Build configuration list for PBXNativeTarget "TaskFlowWidgets" */ = {{
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t{ID_WIDGET_DEBUG_CONFIG} /* Debug */,
\t\t\t\t{ID_WIDGET_RELEASE_CONFIG} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t}};
"""
content = re.sub(r"(/\* Begin XCConfigurationList section \*/\n)", r"\1" + widget_config_list, content)

with open(pbx_path, "w", encoding="utf-8") as f:
    f.write(content)

print("Successfully configured TaskFlowWidgets target in project.pbxproj!")
